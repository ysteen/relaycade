#include "libretro.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#define OPEN(path) LoadLibraryA(path)
#define SYMBOL(handle, name) GetProcAddress(handle, name)
#else
#include <dlfcn.h>
#define OPEN(path) dlopen(path, RTLD_NOW)
#define SYMBOL(handle, name) dlsym(handle, name)
#endif

#define API(F) \
    F(retro_init, void, (void)) \
    F(retro_deinit, void, (void)) \
    F(retro_get_system_info, void, (struct retro_system_info *)) \
    F(retro_set_environment, void, (retro_environment_t)) \
    F(retro_set_video_refresh, void, (retro_video_refresh_t)) \
    F(retro_set_audio_sample_batch, void, (retro_audio_sample_batch_t)) \
    F(retro_set_audio_sample, void, (retro_audio_sample_t)) \
    F(retro_set_input_poll, void, (retro_input_poll_t)) \
    F(retro_set_input_state, void, (retro_input_state_t)) \
    F(retro_set_controller_port_device, void, (unsigned, unsigned)) \
    F(retro_load_game, bool, (const struct retro_game_info *)) \
    F(retro_load_game_special, bool, (unsigned, const struct retro_game_info *, size_t)) \
    F(retro_unload_game, void, (void)) \
    F(retro_run, void, (void)) \
    F(retro_serialize_size, size_t, (void)) \
    F(retro_serialize, bool, (void *, size_t)) \
    F(retro_unserialize, bool, (const void *, size_t)) \
    F(retro_get_memory_data, void *, (unsigned)) \
    F(retro_get_memory_size, size_t, (unsigned))
#define DECLARE(name, result, args) static result (*p_##name) args;
API(DECLARE)
#define retro_init p_retro_init
#define retro_deinit p_retro_deinit
#define retro_get_system_info p_retro_get_system_info
#define retro_set_environment p_retro_set_environment
#define retro_set_video_refresh p_retro_set_video_refresh
#define retro_set_audio_sample_batch p_retro_set_audio_sample_batch
#define retro_set_audio_sample p_retro_set_audio_sample
#define retro_set_input_poll p_retro_set_input_poll
#define retro_set_input_state p_retro_set_input_state
#define retro_set_controller_port_device p_retro_set_controller_port_device
#define retro_load_game p_retro_load_game
#define retro_load_game_special p_retro_load_game_special
#define retro_unload_game p_retro_unload_game
#define retro_run p_retro_run
#define retro_serialize_size p_retro_serialize_size
#define retro_serialize p_retro_serialize
#define retro_unserialize p_retro_unserialize
#define retro_get_memory_data p_retro_get_memory_data
#define retro_get_memory_size p_retro_get_memory_size

#if defined(PROBE_GBA)
#include "mgba-core-probe.c"
#elif defined(PROBE_SNES)
#include "snes-core-probe.c"
#else
#include "libretro-probe.c"
#endif

static void require(int condition, const char *message) {
    if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}
static unsigned char *read_bytes(const char *path, size_t *size) {
    FILE *file = fopen(path, "rb");
    require(file != NULL, "Could not open input");
    require(fseek(file, 0, SEEK_END) == 0, "Could not seek input");
    long length = ftell(file);
    require(length > 0 && length <= 32 * 1024 * 1024, "Invalid input size");
    *size = (size_t)length;
    rewind(file);
    unsigned char *bytes = malloc(*size);
    require(bytes != NULL && fread(bytes, 1, *size, file) == *size, "Could not read input");
    fclose(file);
    return bytes;
}
static void write_bytes(const char *prefix, const char *suffix, void *bytes, size_t size) {
    char path[4096];
    require(snprintf(path, sizeof(path), "%s-%s.bin", prefix, suffix) < (int)sizeof(path), "Path too long");
    FILE *file = fopen(path, "wb");
    require(file != NULL && fwrite(bytes, 1, size, file) == size, "Could not write state");
    fclose(file);
}
static void step(unsigned a, unsigned b) {
#ifdef PROBE_GBA
    probe_step(a, b, 0, 0);
#else
    probe_step(a, b);
#endif
}
static void sequence(int incorrect) {
    for (unsigned frame = 0; frame < 120; frame++) {
        step(incorrect ? 0 : (frame % 29 < 6 ? 256 : 0), frame % 37 < 8 ? 16 : 0);
    }
}
#ifdef PROBE_GBA
static void verify_save_startup(const void *rom, size_t rom_size) {
    for (unsigned players = 2; players <= 4; players++) {
        require(probe_init(rom, rom_size, players), "Could not load startup cartridges");
        unsigned char *saves[4];
        const size_t save_size = 128 * 1024;
        for (unsigned slot = 0; slot < players; slot++) {
            unsigned id = slot ? 0xff + slot : RETRO_MEMORY_SAVE_RAM;
            if (players == 3)
                require(probe_memory_size(id) == save_size, "SRAM size unavailable before first frame");
            saves[slot] = (unsigned char *)probe_memory(id);
            require(saves[slot] != NULL, "SRAM unavailable before first frame");
            require(probe_memory_size(id) == save_size, "Invalid startup SRAM size");
            for (size_t offset = 0; offset < save_size; offset++)
                require(saves[slot][offset] == 0xff, "Fresh cartridge reused a save");
            memset(saves[slot], 0x31 + slot, save_size);
        }
        size_t size = probe_size();
        require(size > 0 && size <= 16 * 1024 * 1024, "Invalid startup state size");
        void *state = malloc(size);
        require(state && probe_save(state, size), "Could not capture seeded initial state");
        for (unsigned slot = 0; slot < players; slot++) memset(saves[slot], 0, save_size);
        require(probe_load(state, size), "Could not restore seeded initial state");
        for (unsigned slot = 0; slot < players; slot++) {
            for (size_t offset = 0; offset < save_size; offset++)
                require(saves[slot][offset] == 0x31 + slot, "Initial state lost a cartridge save");
        }
        free(state);
        probe_close();
    }
    puts("{\"saveStartup\":true,\"players\":[2,3,4],\"frames\":0,\"initialStatePreservesSaves\":true}");
}
#endif
int main(int argc, char **argv) {
    require(argc >= 3, "Usage: probe CORE info | CORE ROM OUTPUT_PREFIX [INITIAL_STATE|-] [SECOND_ROM]");
#ifdef _WIN32
    HANDLE job = CreateJobObjectA(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits.ProcessMemoryLimit = (SIZE_T)1024 * 1024 * 1024;
    require(job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) &&
        AssignProcessToJobObject(job, GetCurrentProcess()) && SetProcessAffinityMask(GetCurrentProcess(), 3), "Could not bound Windows qualification resources");
#endif
    void *library = OPEN(argv[1]);
    require(library != NULL, "Could not load core library");
#define LOAD(name, result, args) p_##name = (result (*) args) SYMBOL(library, #name); require(p_##name != NULL, "Missing " #name);
    API(LOAD)
    struct retro_system_info info;
    retro_get_system_info(&info);
    if (!strcmp(argv[2], "info")) {
        printf("{\"core\":\"%s\",\"version\":\"%s\"}\n", info.library_name, info.library_version);
        return 0;
    }
    require(argc >= 4, "Output prefix is required");
    size_t rom_size;
    void *rom = read_bytes(argv[2], &rom_size);
#ifdef PROBE_GBA
    if (!strcmp(argv[3], "save-startup")) {
        verify_save_startup(rom, rom_size);
        free(rom);
        return 0;
    }
    if (argc > 5) {
        size_t second_size;
        void *second = read_bytes(argv[5], &second_size);
        require(probe_init_pair(rom, rom_size, second, second_size), "Could not load distinct test cartridges");
        free(second);
    } else require(probe_init(rom, rom_size, 2), "Could not load test cartridge");
#else
    require(probe_init(rom, rom_size), "Could not load test cartridge");
#endif
    step(0, 0);
    size_t size = probe_size();
    require(size > 0 && size <= 16 * 1024 * 1024, "Invalid state size");
    void *initial = calloc(1, size), *expected = calloc(1, size), *replayed = calloc(1, size);
    require(initial && expected && replayed, "Out of memory");
    if (argc > 4 && strcmp(argv[4], "-")) {
        size_t supplied_size;
        void *supplied = read_bytes(argv[4], &supplied_size);
        require(supplied_size == size && probe_load(supplied, size), "Cross-platform state rejected");
        free(supplied);
    }
    require(probe_save(initial, size), "Initial serialization failed");
    sequence(0);
    require(probe_save(expected, size), "Serialization failed");
    require(probe_load(initial, size), "State restoration failed");
    sequence(1);
    require(probe_load(initial, size), "Rollback failed");
    sequence(0);
    require(probe_save(replayed, size) && !memcmp(expected, replayed, size), "Rollback state mismatch");
    write_bytes(argv[3], "initial", initial, size);
    write_bytes(argv[3], "final", expected, size);
#ifdef PROBE_GBA
    write_bytes(argv[3], "sram-p1", (void *)probe_memory(0), probe_memory_size(0));
    write_bytes(argv[3], "sram-p2", (void *)probe_memory(256), probe_memory_size(256));
    write_bytes(argv[3], "video", captured_video, captured_video_size);
#endif
    printf("{\"core\":\"%s\",\"version\":\"%s\",\"stateSize\":%zu,\"frames\":120,\"rollback\":true}\n", info.library_name, info.library_version, size);
    probe_close();
    free(initial); free(expected); free(replayed); free(rom);
    return 0;
}

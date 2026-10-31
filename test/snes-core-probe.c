#include "libretro.h"
#include <stdint.h>
#include <string.h>

static unsigned buttons[2];
static bool environment(unsigned command, void *data) {
    if (command == RETRO_ENVIRONMENT_GET_VARIABLE) {
        struct retro_variable *var = data;
        struct { const char *key; const char *value; } values[] = {
            {"snes9x_region", "auto"}, {"snes9x_overclock_superfx", "100%"},
            {"snes9x_overclock_cycles", "disabled"}, {"snes9x_up_down_allowed", "disabled"},
            {"snes9x_audio_interpolation", "gaussian"}, {"snes9x_blargg", "disabled"},
            {"snes9x_randomize_memory", "disabled"},
        };
        for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
            if (!strcmp(var->key, values[i].key)) {
                var->value = values[i].value;
                return true;
            }
        }
        var->value = NULL;
        return false;
    }
    if (command == RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE) {
        *(bool *)data = false;
        return true;
    }
    if (command == RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE) {
        *(int *)data = 3;
        return true;
    }
    return command == RETRO_ENVIRONMENT_SET_PIXEL_FORMAT || command == RETRO_ENVIRONMENT_SET_VARIABLES
        || command == RETRO_ENVIRONMENT_SET_GEOMETRY || command == RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO;
}
static void video(const void *data, unsigned width, unsigned height, size_t pitch) {}
static size_t audio(const int16_t *data, size_t frames) { return frames; }
static void sample(int16_t left, int16_t right) {}
static void poll(void) {}
static int16_t input(unsigned port, unsigned device, unsigned index, unsigned id) {
    return port < 2 && id < 16 && (buttons[port] & (1u << id)) != 0;
}
int probe_init(const void *rom, size_t size) {
    buttons[0] = buttons[1] = 0;
    retro_set_environment(environment);
    retro_set_video_refresh(video);
    retro_set_audio_sample_batch(audio);
    retro_set_audio_sample(sample);
    retro_set_input_poll(poll);
    retro_set_input_state(input);
    retro_init();
    retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
    retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);
    struct retro_game_info game = {NULL, rom, size, NULL};
    return retro_load_game(&game);
}
void probe_step(unsigned a, unsigned b) { buttons[0] = a; buttons[1] = b; retro_run(); }
size_t probe_size(void) { return retro_serialize_size(); }
int probe_save(void *data, size_t size) {
    memset(data, 0, size);
    return retro_serialize(data, size);
}
int probe_load(const void *data, size_t size) { return retro_unserialize(data, size); }
void *probe_memory(unsigned id) { return retro_get_memory_data(id); }
size_t probe_memory_size(unsigned id) { return retro_get_memory_size(id); }
const char *probe_version(void) {
    struct retro_system_info info;
    retro_get_system_info(&info);
    return info.library_version;
}
void probe_close(void) { retro_unload_game(); retro_deinit(); }

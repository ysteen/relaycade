#include "libretro.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static unsigned buttons[2];
static bool environment(unsigned command, void *data) {
    if (command == RETRO_ENVIRONMENT_GET_VARIABLE) {
        struct retro_variable *var = data;
        struct { const char *key; const char *value; } values[] = {
            {"sameboy_link", "enabled"}, {"sameboy_rtc", "accurate"},
            {"sameboy_model_1", "Auto"}, {"sameboy_model_2", "Auto"},
            {"sameboy_audio_output", "Game Boy #1"}, {"sameboy_screen_layout", "left-right"},
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
    if (command == RETRO_ENVIRONMENT_GET_TARGET_SAMPLE_RATE) {
        *(unsigned *)data = 48000;
        return true;
    }
    return command == RETRO_ENVIRONMENT_SET_PIXEL_FORMAT || command == RETRO_ENVIRONMENT_SET_VARIABLES
        || command == RETRO_ENVIRONMENT_SET_GEOMETRY || command == RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO;
}
static void video(const void *data, unsigned width, unsigned height, size_t pitch) {}
static size_t audio(const int16_t *data, size_t frames) { return frames; }
static void poll(void) {}
static int16_t input(unsigned port, unsigned device, unsigned index, unsigned id) {
    return port < 2 && id < 16 && (buttons[port] & (1u << id)) != 0;
}
int probe_init(const void *rom, size_t size) {
    retro_set_environment(environment);
    retro_set_video_refresh(video);
    retro_set_audio_sample_batch(audio);
    retro_set_input_poll(poll);
    retro_set_input_state(input);
    retro_init();
    struct retro_game_info games[2] = {{NULL, rom, size, NULL}, {NULL, rom, size, NULL}};
    return retro_load_game_special(0x101, games, 2);
}
void probe_step(unsigned a, unsigned b) {
    buttons[0] = a; buttons[1] = b;
    retro_run();
}
size_t probe_size(void) { return retro_serialize_size(); }
int probe_save(void *data, size_t size) {
    memset(data, 0, size);
    return retro_serialize(data, size);
}
int probe_load(const void *data, size_t size) { return retro_unserialize(data, size); }
void probe_close(void) { retro_unload_game(); retro_deinit(); }

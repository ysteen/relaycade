#include "libretro.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static unsigned buttons[4], player_count;
static unsigned char captured_video[480 * 480 * 4];
static size_t captured_video_size;
static bool environment(unsigned command, void *data) {
    if (command == RETRO_ENVIRONMENT_GET_VARIABLE) {
        struct retro_variable *var = data;
        struct { const char *key; const char *value; } values[] = {
            {"splitscreen_players", player_count == 4 ? "4" : player_count == 3 ? "3" : "2"},
            {"splitscreen_layout", "auto"}, {"splitscreen_focus_player", "1"},
            {"splitscreen_audio", "player 1"}, {"splitscreen_fs_assist", "off"},
            {"splitscreen_overlays", "off"}, {"splitscreen_audio_low_pass", "off"},
            {"splitscreen_audio_limiter", "off"},
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
    return command == RETRO_ENVIRONMENT_SET_PIXEL_FORMAT || command == RETRO_ENVIRONMENT_SET_VARIABLES
        || command == RETRO_ENVIRONMENT_SET_GEOMETRY || command == RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO
        || command == RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO;
}
static void video(const void *data, unsigned width, unsigned height, size_t pitch) {
    if (data && pitch * height <= sizeof(captured_video)) {
        captured_video_size = pitch * height;
        memcpy(captured_video, data, captured_video_size);
    }
}
static size_t audio(const int16_t *data, size_t frames) { return frames; }
static void poll(void) {}
static int16_t input(unsigned port, unsigned device, unsigned index, unsigned id) {
    return port < player_count && id < 16 && (buttons[port] & (1u << id)) != 0;
}
static int probe_setup(unsigned players) {
    if (players < 2 || players > 4) return false;
    player_count = players;
    retro_set_environment(environment);
    retro_set_video_refresh(video);
    retro_set_audio_sample_batch(audio);
    retro_set_input_poll(poll);
    retro_set_input_state(input);
    retro_init();
    return true;
}
int probe_init_pair(const void *first, size_t first_size, const void *second, size_t second_size) {
    if (!probe_setup(2)) return false;
    struct retro_game_info games[2] = {
        {NULL, first, first_size, NULL}, {NULL, second, second_size, NULL}
    };
    return retro_load_game_special(0x201, games, 2);
}
int probe_init(const void *rom, size_t size, unsigned players) {
    if (!probe_setup(players)) return false;
    struct retro_game_info games[4];
    for (unsigned i = 0; i < players; i++) games[i] = (struct retro_game_info){NULL, rom, size, NULL};
    return retro_load_game_special(0x1ff + players, games, players);
}
void probe_step(unsigned a, unsigned b, unsigned c, unsigned d) {
    buttons[0] = a; buttons[1] = b; buttons[2] = c; buttons[3] = d;
    retro_run();
}
size_t probe_size(void) { return retro_serialize_size(); }
int probe_save(void *data, size_t size) {
    memset(data, 0, size);
    return retro_serialize(data, size);
}
int probe_load(const void *data, size_t size) { return retro_unserialize(data, size); }
const void *probe_memory(unsigned id) { return retro_get_memory_data(id); }
size_t probe_memory_size(unsigned id) { return retro_get_memory_size(id); }
void probe_close(void) { retro_unload_game(); retro_deinit(); }

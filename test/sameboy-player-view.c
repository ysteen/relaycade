#define main original_probe_main
#include "native-library-probe.c"
#undef main

static uint32_t pixels[320 * 288], dual[320 * 288];
static unsigned video_width, video_height;
static int16_t samples[8192], reference_audio[2][8192];
static size_t sample_count, reference_count[2];
static bool options_changed;
static const char *audio_device = "Game Boy #1";

static bool view_environment(unsigned command, void *data) {
    if (command == RETRO_ENVIRONMENT_GET_VARIABLE &&
        !strcmp(((struct retro_variable *)data)->key, "sameboy_audio_output")) {
        ((struct retro_variable *)data)->value = audio_device;
        return true;
    }
    if (command == RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE) {
        *(bool *)data = options_changed;
        options_changed = false;
        return true;
    }
    return environment(command, data);
}
static void capture_video(const void *data, unsigned width, unsigned height, size_t pitch) {
    require(data && width * height <= sizeof(pixels) / sizeof(*pixels), "Invalid video frame");
    video_width = width; video_height = height;
    for (unsigned y = 0; y < height; y++)
        memcpy(pixels + y * width, (const char *)data + y * pitch, width * sizeof(*pixels));
}
static size_t capture_audio(const int16_t *data, size_t frames) {
    require(sample_count + frames * 2 <= sizeof(samples) / sizeof(*samples), "Invalid audio frame");
    memcpy(samples + sample_count, data, frames * 2 * sizeof(*data));
    sample_count += frames * 2;
    return frames;
}
static void advance(void) {
    for (unsigned i = 0; i < 45; i++) {
        sample_count = 0;
        step(i % 11 < 3 ? 256 : 0, i % 17 < 2 ? 16 : 0);
    }
}
int main(int argc, char **argv) {
    require(argc == 5, "Usage: sameboy-player-view CORE FIRST_ROM SECOND_ROM VIEW_FILE");
    void *library = OPEN(argv[1]);
    require(library != NULL, "Could not load SameBoy");
    API(LOAD)
    size_t size1, size2;
    void *first = read_bytes(argv[2], &size1), *second = read_bytes(argv[3], &size2);
    _putenv_s("ROMM_NETPLAY_PLAYER_FILE", "");
    require(probe_init_pair(first, size1, second, size2), "Could not load cartridges");
    retro_set_environment(view_environment);
    retro_set_video_refresh(capture_video);
    retro_set_audio_sample_batch(capture_audio);
    for (unsigned i = 0; i < 480; i++) { sample_count = 0; step(0, 0); }
    size_t size = probe_size();
    void *initial = malloc(size), *expected = malloc(size), *actual = malloc(size);
    require(initial && expected && actual && probe_save(initial, size), "Initial state failed");
    advance();
    require(video_width == 320 && video_height == 144, "Default dual view changed");
    memcpy(dual, pixels, sizeof(dual));
    require(probe_save(expected, size), "Could not save baseline");
    reference_count[0] = sample_count;
    memcpy(reference_audio[0], samples, sample_count * sizeof(*samples));
    audio_device = "Game Boy #2"; options_changed = true;
    require(probe_load(initial, size), "Baseline restore failed");
    advance();
    reference_count[1] = sample_count;
    memcpy(reference_audio[1], samples, sample_count * sizeof(*samples));
    require(reference_count[0] && reference_count[1], "No audio captured");
    require(reference_count[0] != reference_count[1] ||
        memcmp(reference_audio[0], reference_audio[1], reference_count[0] * sizeof(*samples)),
        "Use distinct cartridges with audible output for this test");
    audio_device = "Game Boy #1"; options_changed = true;
    _putenv_s("ROMM_NETPLAY_PLAYER_FILE", argv[4]);
    const unsigned views[] = {1, 2, 0, 4, 2, 1};
    for (unsigned i = 0; i < sizeof(views) / sizeof(*views); i++) {
        FILE *file = fopen(argv[4], "wb");
        require(file != NULL, "Could not write player assignment");
        fputc('0' + views[i], file); fclose(file);
        require(probe_load(initial, size), "Could not restore shared state");
        advance();
        require(video_width == 160 && video_height == 144, "Local view is not one screen");
        require(probe_save(actual, size) && !memcmp(expected, actual, size), "Presentation changed rollback state");
        if (views[i] == 1 || views[i] == 2) {
            unsigned player = views[i] - 1;
            for (unsigned y = 0; y < 144; y++)
                require(!memcmp(pixels + y * 160, dual + y * 320 + player * 160, 160 * sizeof(*pixels)), "Wrong player's video");
            require(sample_count == reference_count[player] &&
                !memcmp(samples, reference_audio[player], sample_count * sizeof(*samples)), "Wrong player's audio");
        } else {
            for (unsigned p = 0; p < 160 * 144; p++) require(pixels[p] == 0, "Waiting screen leaked video");
            for (size_t p = 0; p < sample_count; p++) require(samples[p] == 0, "Waiting screen leaked audio");
        }
    }
    probe_close();
    free(first); free(second); free(initial); free(expected); free(actual);
    puts("{\"localScreens\":[1,2],\"localAudio\":[1,2],\"waitingBlank\":true,\"reassignment\":true,\"rollbackStateUnchanged\":true}");
    return 0;
}

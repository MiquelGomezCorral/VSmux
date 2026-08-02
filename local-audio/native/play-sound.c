#define MA_IMPLEMENTATION
#include "miniaudio.h"

#include <stdio.h>
#include <stdlib.h>

int main(int argc, char** argv)
{
    ma_engine engine;
    ma_sound sound;
    float volume = 1.0f;

    if (argc < 2) {
        return 1;
    }

    if (argc >= 3) {
        volume = (float)atof(argv[2]);
        if (volume < 0.0f) volume = 0.0f;
        if (volume > 1.0f) volume = 1.0f;
    }

    if (ma_engine_init(NULL, &engine) != MA_SUCCESS) {
        return 2;
    }

    if (ma_sound_init_from_file(&engine, argv[1], 0, NULL, NULL, &sound) != MA_SUCCESS) {
        ma_engine_uninit(&engine);
        return 3;
    }

    ma_sound_set_volume(&sound, volume);
    ma_sound_start(&sound);

    while (!ma_sound_at_end(&sound)) {
        ma_sleep(10);
    }

    ma_sound_uninit(&sound);
    ma_engine_uninit(&engine);
    return 0;
}

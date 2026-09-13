#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int width, height;
static char *pixels;
static float *depth;
static volatile sig_atomic_t stopped;
static struct sigaction old_interrupt;
static bool active, tty;
static void stop(int signal_number) { (void)signal_number; stopped = 1; }

void donut_finish(void) {
    if (!active) return;
    if (tty) fputs("\x1b[?25h\x1b[?1049l", stdout);
    fflush(stdout);
    sigaction(SIGINT, &old_interrupt, NULL);
    free(pixels); free(depth); pixels = NULL; depth = NULL;
    active = false;
}

bool donut_start(int w, int h) {
    struct winsize terminal;
    if (isatty(STDOUT_FILENO) && ioctl(STDOUT_FILENO, TIOCGWINSZ, &terminal) == 0) {
        if (terminal.ws_col > 0 && w > terminal.ws_col) w = terminal.ws_col;
        if (terminal.ws_row > 1 && h >= terminal.ws_row) h = terminal.ws_row - 1;
    }
    if (active || w < 16 || h < 8 || w > 240 || h > 120) return false;
    width = w; height = h;
    pixels = malloc((size_t)w * h);
    depth = malloc((size_t)w * h * sizeof(float));
    if (!pixels || !depth) { free(pixels); free(depth); return false; }
    struct sigaction action = {0};
    action.sa_handler = stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, &old_interrupt) != 0) {
        free(pixels); free(depth); return false;
    }
    active = true; stopped = 0; tty = isatty(STDOUT_FILENO);
    if (tty) fputs("\x1b[?1049h\x1b[?25l\x1b[2J", stdout);
    return true;
}

bool donut_frame(double A, double B) {
    if (!active || stopped) return false;
    const double pi = 3.14159265358979323846;
    const double cosA = cos(A), sinA = sin(A), cosB = cos(B), sinB = sin(B);
    const double K1 = width * 5.0 * 3.0 / (8.0 * 3.0) / 2.0;
    const char *light = ".,-~:;=!*#$@";
    memset(pixels, ' ', (size_t)width * height);
    memset(depth, 0, (size_t)width * height * sizeof(float));
    for (double theta = 0; theta < 2 * pi; theta += .07) {
        const double ct = cos(theta), st = sin(theta), cx = 2 + ct;
        for (double phi = 0; phi < 2 * pi; phi += .02) {
            const double cp = cos(phi), sp = sin(phi);
            const double x = cx * (cosB * cp + sinA * sinB * sp) - st * cosA * sinB;
            const double y = cx * (sinB * cp - sinA * cosB * sp) + st * cosA * cosB;
            const double iz = 1 / (5 + cosA * cx * sp + st * sinA);
            const int px = (int)(width / 2.0 + K1 * iz * x);
            const int py = (int)(height / 2.0 - K1 * iz * y);
            const double luminance = cp * ct * sinB - cosA * ct * sp - sinA * st
                + cosB * (cosA * st - ct * sinA * sp);
            const int shade = (int)(luminance * 8);
            if (luminance > 0 && px >= 0 && px < width && py >= 0 && py < height && shade >= 0 && shade < 12) {
                const int index = py * width + px;
                if (iz > depth[index]) { depth[index] = (float)iz; pixels[index] = light[shade]; }
            }
        }
    }
    if (tty) fputs("\x1b[H", stdout);
    for (int y = 0; y < height; y++) {
        fwrite(pixels + y * width, 1, (size_t)width, stdout);
        fputs(tty ? "\r\n" : "\n", stdout);
    }
    fflush(stdout);
    struct timespec delay = {0, 16000000};
    nanosleep(&delay, NULL);
    return !stopped;
}

// Library unloading also restores the terminal after an APN error.
__attribute__((destructor)) static void cleanup(void) { donut_finish(); }

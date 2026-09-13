#include <stdint.h>
#include <stdbool.h>
#include <string.h>
int32_t add(int32_t a, int32_t b) { return a + b; }
uint64_t echo_u64(uint64_t a) { return a; }
double half(double x) { return x / 2; }
float half_f32(float x) { return x / 2; }
bool invert(bool x) { return !x; }
int32_t answer(void) { return 42; }
int32_t text_length(const char *s) { return (int32_t)strlen(s); }
const char *greeting(void) { return "hello from C"; }
void increment(int32_t *p) { ++*p; }
void *echo_pointer(void *p) { return p; }
void *null_pointer(void) { return 0; }

static int32_t cell;
int32_t *cell_pointer(void) { return &cell; }
int32_t cell_value(void) { return cell; }

int32_t tick(void) { return ++cell; }
void tick_void(void) { ++cell; }

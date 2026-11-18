/* se1mod: the C interface between Serious Engine and the Rust mod layer (rust/se1-mod).
 *
 * The engine owns the simulation; Rust adds new systems (director, multiplayer glue, map
 * tooling hooks) and reads its behaviour from config files. Keep this interface small,
 * C-only and versioned: bump SE1MOD_API_VERSION on any layout change.
 *
 * Direction engine -> Rust: se1mod_* functions below (implemented in Rust).
 * Direction Rust -> engine: the SE1ModHost function table passed to se1mod_init().
 */
#ifndef SE1MOD_H
#define SE1MOD_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SE1MOD_API_VERSION 1

typedef struct SE1ModHost {
  uint32_t api_version;   /* SE1MOD_API_VERSION */
  const char *game;       /* "SamTFE" or "SamTSE" */
  const char *data_dir;   /* game data root in the (virtual) filesystem, e.g. "/" */

  /* print to the engine console / log */
  void (*log)(const char *msg);
  /* run console script, exactly as typed in the in-game console */
  void (*shell_execute)(const char *script);
  /* console symbols: returns 1 on success, 0 if the symbol doesn't exist / has another type */
  int (*get_index)(const char *name, int32_t *out);
  int (*get_float)(const char *name, float *out);
  int (*set_index)(const char *name, int32_t value);
  int (*set_float)(const char *name, float value);
  int (*set_string)(const char *name, const char *value);
} SE1ModHost;

/* called once after the engine and game library are initialized; returns 0 on success */
int  se1mod_init(const SE1ModHost *host);
/* called once per presented frame; tm_real = engine real-time clock in seconds */
void se1mod_frame(double tm_real);
/* called when a new session (level) has started */
void se1mod_level_started(const char *world_file);
/* called before the engine shuts down */
void se1mod_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* SE1MOD_H */

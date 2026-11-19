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

#define SE1MOD_API_VERSION 3

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

  /* ---- API 2: gameplay (single-player local world) ---- */
  /* simulation time in seconds (stops while paused) */
  double (*game_time)(void);
  /* local player: position (x, y, z; y is up) and health; returns 0 if there is no live player */
  int (*player)(float *pos3, float *health);
  /* add health to the local player, never above `max` */
  void (*player_heal)(float amount, float max);
  /* spawn an entity class (e.g. "Classes\\Boneman.ecl") at a position; returns a handle > 0, or 0 */
  int (*spawn)(const char *class_file, const float *pos3);
  /* handle state: 1 alive, 0 dead or gone; position of a live handle */
  int (*alive)(int handle);
  int (*position)(int handle, float *pos3);
  /* damage a handle's entity as if the local player hit it */
  void (*damage)(int handle, float amount);
  /* forget a handle (frees the slot) */
  void (*release)(int handle);
  /* pause / unpause the local game */
  void (*set_pause)(int on);
  /* web page: read a numeric page option (Module[name], 0 if unset); post a JSON message to the page
     overlay (Module.se1ModUi); poll a value the page sent back (-1 if none) */
  double (*page_option)(const char *name);
  void (*ui_post)(const char *json);
  int (*ui_poll)(void);
  /* close the in-game computer (NETRICSA) if it is open */
  void (*close_computer)(void);
  /* v3: the local player's view direction (unit vector, where they aim); 0 if there is no player */
  int (*player_view)(float *dir3);
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

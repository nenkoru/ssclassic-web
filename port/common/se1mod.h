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

#define SE1MOD_API_VERSION 8

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
  /* v4: gameplay toolkit (port/common/Se1ModEntities.cpp). Spawning a class or variant whose
     model/texture/sound isn't in the data is fatal: check file_exists first. */
  /* monster: variant -1 = class default; hp_mul/stretch 0 or 1 = unchanged; glow 0xRRGGBBAA added
     to its lighting (0 = none); boss shows the HUD boss bar. It hunts the player at once. */
  int (*spawn_enemy)(const char *cls, int variant, const float *pos3, float hp_mul, float stretch, uint32_t glow, int boss);
  float (*health)(int h);                       /* 0 when dead or gone */
  float (*max_health)(int h);
  int (*file_exists)(const char *path);
  void (*effect)(int type, const float *pos3, float size);   /* BasicEffect (BET_*), visual + sound */
  void (*lightning)(const float *from3, const float *to3, float size, float life);
  void (*sound)(const char *path, float volume); /* 2D, plays while paused too */
  int (*spawn_item)(const char *cls, int type, const float *pos3);
  int (*exists)(int h);                         /* any entity (items, effects): still in the world */
  void (*set_position)(int h, const float *pos3);
  void (*destroy)(int h);                       /* remove the entity and free the handle */
  int (*weapon)(void);                          /* current WeaponType */
  int (*weapons_owned)(void);                   /* bit (1 << (WeaponType-1)) per weapon */
  void (*ammo)(int32_t *out12);                 /* bullets shells rockets grenades cells ironballs, then maxima */
  void (*give_ammo)(int ait_type, int amount);  /* AmmoItemType, capped by the player's maximum */
  void (*give_weapon)(int wit_type);            /* WeaponItemType */
  void (*projectile)(int type, const float *pos3, const float *dir3, float speed);   /* launched by the player */
  float (*armor)(float add, float max);         /* add armor up to max; returns the armor */
  int (*player_eye)(float *pos3, float *dir3);  /* eye position and view direction */
  int (*player_hurt)(float *from, float *amount);  /* where the player was last hit from (position) and accumulated damage; 1 if new */
  /* v8: bots (port/common/Se1ModBots.cpp, notes/bots.md). Bots exist on the server only; their
     actions are set from se1mod_bot_tick, once per simulated tick. */
  int   (*bot_add)(const char *name);          /* a server-side player; its player index, or -1 */
  void  (*bot_remove)(int id);
  int   (*bot_state)(int id, float *out8);     /* eye x y z, heading, pitch (deg; heading +left, pitch +up), health, armor, weapon; 0 if gone */
  void  (*bot_action)(int id, const float *move3, const float *rot3, uint32_t buttons);
        /* move: strafe (+right), up (+jump), forward (NEGATIVE is forward), m/s up to 10;
           rot: ABSOLUTE accumulated heading, pitch, bank (only the change since the last action counts);
           buttons: TFE Player.es bits (fire 1, reload 2, next 4, prev 8, use 32, weapon select type<<9) */
  float (*ray)(const float *from3, const float *to3, int hit_models);   /* distance to the first solid hit, -1 if clear */
  int   (*enemies)(int32_t *ids, float *pos4, int max);   /* live enemies: entity id; x y z health */
  int   (*items)(int32_t *kinds, float *pos3, int max);   /* pickable now: 0 health, 1 armor, 2 ammo, 3 weapon */
  int   (*humans)(float *pos3, int max);                  /* live players that are not bots */
  int   (*world_bounds)(float *min3, float *max3);        /* union of the level's brush boxes; 0 if none */
  int   (*is_server)(void);
} SE1ModHost;

/* called once after the engine and game library are initialized; returns 0 on success */
int  se1mod_init(const SE1ModHost *host);
/* called once per presented frame; tm_real = engine real-time clock in seconds */
 void se1mod_frame(double tm_real);
/* called when an entity is about to receive damage; returns the amount to apply (the mod may
   scale it; returning the input leaves it unchanged).
   target: the mod's handle for the damaged entity, or 0 if the mod has none.
   source: 0 = other (monsters, barrels, the world), 1 = the local player (bullets,
     projectiles, melee: their inflictor is the player), 2 = the mod's own damage
     (made inside host.damage).
   damage_type: the engine's DamageType (DMT_*) value.
   weapon: v6: the WeaponType of the projectile that dealt the damage (0 = hit-scan
     bullets, melee, or not a player projectile). Lets the mod scale and credit the
     hit to the gun that fired the projectile, not the gun held when it lands. */
float se1mod_damage(int target, int source, int damage_type, float amount, int weapon);
/* v8: called on the server once per simulated tick, before the tick's actions go out: set the
   bots' actions here (host->bot_action) */
void se1mod_bot_tick(void);
/* called when a new session (level) has started */
void se1mod_level_started(const char *world_file);
/* called before the engine shuts down */
void se1mod_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* SE1MOD_H */

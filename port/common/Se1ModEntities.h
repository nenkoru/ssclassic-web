/* Entity-typed helpers for the se1mod host (implemented in Se1ModEntities.cpp, entities library).
 * Spawn functions throw char * like CWorld::CreateEntity_t. */
#pragma once

class CEntity;
class CWorld;

CEntity *SE1ModEnt_SpawnEnemy(CWorld &wo, const char *cls, int variant, const FLOAT3D &pos, float hpMul,
                              float stretch, ULONG glow, int boss, CEntity *penPlayer);
CEntity *SE1ModEnt_SpawnItem(CWorld &wo, const char *cls, int type, const FLOAT3D &pos);
void SE1ModEnt_Effect(CWorld &wo, int type, const FLOAT3D &pos, float size);
void SE1ModEnt_Lightning(CWorld &wo, const FLOAT3D &from, const FLOAT3D &to, float size, float life);
CEntity *SE1ModEnt_Projectile(CWorld &wo, CEntity *penLauncher, int type, const FLOAT3D &pos, const FLOAT3D &dir, float speed);   /* returns the projectile */
float SE1ModEnt_MaxHealth(CEntity *pen);
int SE1ModEnt_Weapon(CEntity *penPlayer);
int SE1ModEnt_WeaponsOwned(CEntity *penPlayer);
void SE1ModEnt_Ammo(CEntity *penPlayer, int *out12);   /* 6 counts, then 6 maximums */
void SE1ModEnt_GiveAmmo(CEntity *penPlayer, int aitType, int amount);
void SE1ModEnt_GiveWeapon(CEntity *penPlayer, int witType);
void SE1ModEnt_Armor(CEntity *penPlayer, float add, float max);
float SE1ModEnt_Armor(CEntity *penPlayer);
void SE1ModEnt_Eye(CEntity *penPlayer, FLOAT3D &pos, FLOAT3D &dir);
int SE1ModEnt_ProjectileWeapon(CEntity *pen);   /* WeaponType the projectile was fired with, 0 if not a player projectile */

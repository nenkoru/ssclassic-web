/* Unit test for port/common/CaseFs.c (case-insensitive fopen/open/opendir on WASMFS), linked the
 * same way as the threaded engine build:
 *
 *   emcc -O1 -sWASMFS -Wl,--wrap=fopen -Wl,--wrap=open -Wl,--wrap=opendir \
 *        tests/casefs_test.c port/common/CaseFs.c -o casefs_test.js && node casefs_test.js
 *
 * The files live in WASMFS's in-memory backend; the game's Windows-era paths disagree with the
 * data's letter case, so every lookup below spells a path differently from how it was created.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int failures, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { failures++; printf("FAIL  " __VA_ARGS__); printf("\n"); } } while (0)

static void put(const char *path, const char *text)
{
  FILE *f = fopen(path, "wb");
  if (!f) { printf("setup: cannot create %s (errno %d)\n", path, errno); exit(2); }
  fputs(text, f);
  fclose(f);
}

/* contents through fopen, or NULL */
static char *slurp_fopen(const char *path)
{
  static char buf[256];
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  buf[n] = 0;
  fclose(f);
  return buf;
}

/* contents through open/read, or NULL */
static char *slurp_open(const char *path)
{
  static char buf[256];
  int fd = open(path, O_RDONLY);
  if (fd < 0) return NULL;
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  buf[n < 0 ? 0 : n] = 0;
  return buf;
}

static int dir_has(const char *path, const char *name)
{
  DIR *d = opendir(path);
  if (!d) return -1;
  int found = 0;
  struct dirent *de;
  while ((de = readdir(d)) != NULL) if (strcmp(de->d_name, name) == 0) found = 1;
  closedir(d);
  return found;
}

static int exists_exact(const char *path) { struct stat st; return stat(path, &st) == 0; }

#define EXPECT_TEXT(got, want, what) CHECK((got) && strcmp((got), (want)) == 0, "%s: got \"%s\", want \"%s\"", what, (got) ? (got) : "(null)", want)

int main(void)
{
  /* the layout of the game data: mixed-case directories and files */
  mkdir("/data", 0777);
  mkdir("/data/Levels", 0777);
  mkdir("/data/Demos", 0777);
  mkdir("/data/Sounds", 0777);
  mkdir("/data/Sounds/Music", 0777);
  put("/data/Levels/Intro.wld", "intro");
  put("/data/Levels/Intro.wld.bak", "backup");          /* longer name with the same prefix */
  put("/data/Levels/MAP.WLD.BAK", "map-backup");         /* sorts before Map.wld (byte order) */
  put("/data/Levels/Map.wld", "map");
  put("/data/Demos/auto-demo0001.ini", "demo");        /* lower case on disk ... */
  put("/data/Sounds/Music/Theme.ogg", "music");

  /* exact case still works */
  EXPECT_TEXT(slurp_fopen("/data/Levels/Intro.wld"), "intro", "fopen exact case");
  EXPECT_TEXT(slurp_open("/data/Levels/Intro.wld"), "intro", "open exact case");

  /* mixed case, every component */
  EXPECT_TEXT(slurp_fopen("/DATA/levels/INTRO.WLD"), "intro", "fopen mixed case");
  EXPECT_TEXT(slurp_fopen("/data/Demos/Auto-Demo0001.ini"), "demo", "fopen file name case (Auto-Demo0001.ini)");
  EXPECT_TEXT(slurp_open("/Data/sounds/MUSIC/theme.OGG"), "music", "open mixed case, nested");
  EXPECT_TEXT(slurp_fopen("/data/levels/intro.wld.BAK"), "backup", "fopen picks the full-length match");
  EXPECT_TEXT(slurp_fopen("/data/LEVELS/intro.wld"), "intro", "fopen does not match a longer name");
  EXPECT_TEXT(slurp_fopen("/data/levels/map.wld"), "map", "fopen skips a longer name listed first");
  CHECK(dir_has("/DATA/LEVELS", "Intro.wld") == 1, "opendir mixed case lists the directory");
  CHECK(dir_has("/data/sounds/music", "Theme.ogg") == 1, "opendir nested mixed case");

  /* relative paths (the engine opens files relative to its working directory) */
  CHECK(chdir("/data") == 0, "chdir /data");
  EXPECT_TEXT(slurp_fopen("LEVELS/intro.wld"), "intro", "fopen relative mixed case");
  EXPECT_TEXT(slurp_open("demos/AUTO-DEMO0001.INI"), "demo", "open relative mixed case");
  CHECK(dir_has("sounds", "Music") == 1, "opendir relative mixed case");

  /* through lowercase symlinks: to a directory and to a file */
  CHECK(symlink("/data", "/game") == 0, "symlink /game -> /data");
  CHECK(symlink("/data/Sounds/Music", "/data/music") == 0, "symlink /data/music -> /data/Sounds/Music");
  CHECK(symlink("/data/Levels/Intro.wld", "/data/levels-intro") == 0, "symlink to a file");
  EXPECT_TEXT(slurp_fopen("/GAME/Levels/INTRO.wld"), "intro", "fopen through a lowercase directory symlink");
  EXPECT_TEXT(slurp_open("/Game/demos/Auto-Demo0001.ini"), "demo", "open through a lowercase directory symlink");
  EXPECT_TEXT(slurp_fopen("/data/MUSIC/THEME.OGG"), "music", "fopen through a nested lowercase symlink");
  EXPECT_TEXT(slurp_fopen("/data/Levels-Intro"), "intro", "fopen of a lowercase file symlink in mixed case");
  CHECK(dir_has("/GAME/SOUNDS", "Music") == 1, "opendir through a lowercase directory symlink");

  /* missing files stay missing, with ENOENT */
  errno = 0;
  CHECK(fopen("/data/levels/Missing.wld", "rb") == NULL && errno == ENOENT, "fopen of a missing file: NULL/ENOENT (errno %d)", errno);
  errno = 0;
  CHECK(open("/data/NoSuchDir/x", O_RDONLY) < 0 && errno == ENOENT, "open in a missing directory: -1/ENOENT (errno %d)", errno);
  errno = 0;
  CHECK(opendir("/data/nosuchdir") == NULL && errno == ENOENT, "opendir of a missing directory: NULL/ENOENT (errno %d)", errno);

  /* creating files: existing directories are matched, the new name is kept as given */
  FILE *f = fopen("/data/levels/NewFile.txt", "w");
  CHECK(f != NULL, "fopen(w) in a mixed-case directory");
  if (f) { fputs("new", f); fclose(f); }
  CHECK(exists_exact("/data/Levels/NewFile.txt"), "fopen(w) created the file in /data/Levels with its own case");
  int fd = open("/DATA/demos/Created.ini", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  CHECK(fd >= 0, "open(O_CREAT) in a mixed-case directory (errno %d)", errno);
  if (fd >= 0) { CHECK(write(fd, "x", 1) == 1, "write to the created file"); close(fd); }
  CHECK(exists_exact("/data/Demos/Created.ini"), "open(O_CREAT) created the file in /data/Demos");
  struct stat st;
  CHECK(stat("/data/Demos/Created.ini", &st) == 0 && (st.st_mode & 0777) != 0, "created file has a mode");

  /* paths longer than the resolver's buffer fail cleanly */
  char longpath[2048];
  memset(longpath, 'a', sizeof longpath - 1);
  longpath[0] = '/';
  longpath[sizeof longpath - 1] = 0;
  CHECK(fopen(longpath, "rb") == NULL, "overlong path: NULL, no crash");
  CHECK(fopen("", "rb") == NULL, "empty path: NULL");

  printf("casefs: %d/%d checks passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}

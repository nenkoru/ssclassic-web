/* Case-insensitive file opens (linked with -Wl,--wrap=fopen,--wrap=open,--wrap=opendir).
 *
 * The game was written for Windows: its data and code disagree on letter case
 * (e.g. the engine asks for "Demos/Auto-Demo0001.ini", the file is "auto-demo0001.ini").
 * MEMFS builds patch FS.lookupNode in JS (port/web/pre.js); WASMFS has no such hook, so a
 * missed open is retried here: each path component that does not exist is matched against its
 * directory's entries with strcasecmp. Exact-case paths never pay for this (the first open
 * succeeds), and a component with no match is kept as given, so creating new files still works.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

FILE *__real_fopen(const char *path, const char *mode);
int __real_open(const char *path, int flags, ...);
DIR *__real_opendir(const char *path);

/* resolve `in` component by component into `out`; returns 1 if anything changed */
static int resolve_case(const char *in, char *out, size_t cap)
{
  size_t n = 0;
  int changed = 0;
  const char *p = in;
  struct stat st;
  if (*p == '/') { out[n++] = '/'; p++; }
  out[n] = 0;
  while (*p) {
    const char *e = strchr(p, '/');
    size_t len = e ? (size_t)(e - p) : strlen(p);
    if (n + len + 2 >= cap) return 0;
    memcpy(out + n, p, len); out[n + len] = 0;
    if (len && stat(out, &st) != 0) {          /* not there as spelled: look for a case match */
      char dir[1024];
      size_t dn = n ? n : 0;
      if (dn >= sizeof(dir)) return 0;
      memcpy(dir, out, dn); dir[dn] = 0;
      if (dn > 1 && dir[dn - 1] == '/') dir[dn - 1] = 0;
      DIR *d = __real_opendir(dn ? dir : ".");
      if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL) {
          if (strlen(de->d_name) == len && strncasecmp(de->d_name, p, len) == 0) {
            memcpy(out + n, de->d_name, len); changed = 1; break;
          }
        }
        closedir(d);
      }
    }
    n += len;
    if (!e) break;
    out[n++] = '/'; out[n] = 0;
    p = e + 1;
  }
  out[n] = 0;
  return changed;
}

FILE *__wrap_fopen(const char *path, const char *mode)
{
  FILE *f = __real_fopen(path, mode);
  if (f || errno != ENOENT || !path || !*path) return f;
  char fixed[1024];
  if (!resolve_case(path, fixed, sizeof(fixed))) { errno = ENOENT; return NULL; }
  return __real_fopen(fixed, mode);
}

int __wrap_open(const char *path, int flags, ...)
{
  mode_t m = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); m = (mode_t)va_arg(ap, int); va_end(ap); }
  int fd = __real_open(path, flags, m);
  if (fd >= 0 || errno != ENOENT || !path || !*path) return fd;
  char fixed[1024];
  if (!resolve_case(path, fixed, sizeof(fixed))) { errno = ENOENT; return -1; }
  return __real_open(fixed, flags, m);
}

DIR *__wrap_opendir(const char *path)
{
  DIR *d = __real_opendir(path);
  if (d || errno != ENOENT || !path || !*path) return d;
  char fixed[1024];
  if (!resolve_case(path, fixed, sizeof(fixed))) { errno = ENOENT; return NULL; }
  return __real_opendir(fixed);
}

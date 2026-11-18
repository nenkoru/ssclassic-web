/* qsort replacement (linked with -Wl,--wrap=qsort).
 *
 * musl's qsort is a smoothsort: good worst case, but slow on the engine's typical inputs
 * (the renderer sorts delayed models and scene polygons every frame; ~6% of the worker's time
 * went to sift/trinkle). This is an introsort: median-of-three quicksort, insertion sort for
 * small ranges, heapsort if recursion gets too deep. Like any qsort it is not stable.
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef int (*cmp_fn)(const void *, const void *);

static inline void swap_bytes(char *a, char *b, size_t n)
{
  if (a == b) return;
  if (n == 4 && !(((uintptr_t)a | (uintptr_t)b) & 3)) { uint32_t t = *(uint32_t *)a; *(uint32_t *)a = *(uint32_t *)b; *(uint32_t *)b = t; return; }
  if (n == 8 && !(((uintptr_t)a | (uintptr_t)b) & 7)) { uint64_t t = *(uint64_t *)a; *(uint64_t *)a = *(uint64_t *)b; *(uint64_t *)b = t; return; }
  char tmp[64];
  while (n) {
    size_t k = n < sizeof(tmp) ? n : sizeof(tmp);
    memcpy(tmp, a, k); memcpy(a, b, k); memcpy(b, tmp, k);
    a += k; b += k; n -= k;
  }
}

static void insertion_sort(char *base, size_t n, size_t sz, cmp_fn cmp)
{
  for (size_t i = 1; i < n; i++)
    for (size_t j = i; j > 0 && cmp(base + (j - 1) * sz, base + j * sz) > 0; j--)
      swap_bytes(base + (j - 1) * sz, base + j * sz, sz);
}

static void sift_down(char *base, size_t start, size_t n, size_t sz, cmp_fn cmp)
{
  size_t root = start;
  for (;;) {
    size_t child = 2 * root + 1;
    if (child >= n) return;
    if (child + 1 < n && cmp(base + child * sz, base + (child + 1) * sz) < 0) child++;
    if (cmp(base + root * sz, base + child * sz) >= 0) return;
    swap_bytes(base + root * sz, base + child * sz, sz);
    root = child;
  }
}

static void heap_sort(char *base, size_t n, size_t sz, cmp_fn cmp)
{
  for (size_t i = n / 2; i-- > 0;) sift_down(base, i, n, sz, cmp);
  for (size_t end = n; end-- > 1;) {
    swap_bytes(base, base + end * sz, sz);
    sift_down(base, 0, end, sz, cmp);
  }
}

static void intro_sort(char *base, size_t n, size_t sz, cmp_fn cmp, int depth)
{
  while (n > 16) {
    if (depth-- == 0) { heap_sort(base, n, sz, cmp); return; }
    /* median of three into base[0] as the pivot */
    char *a = base, *b = base + (n / 2) * sz, *c = base + (n - 1) * sz;
    if (cmp(b, a) < 0) swap_bytes(a, b, sz);
    if (cmp(c, b) < 0) { swap_bytes(b, c, sz); if (cmp(b, a) < 0) swap_bytes(a, b, sz); }
    swap_bytes(base, b, sz);                      /* pivot to the front */
    /* Hoare partition around base[0] */
    size_t i = 0, j = n;
    for (;;) {
      do i++; while (i < n && cmp(base + i * sz, base) < 0);
      do j--; while (j > 0 && cmp(base + j * sz, base) > 0);   /* guard: inconsistent comparators */
      if (i >= j) break;
      swap_bytes(base + i * sz, base + j * sz, sz);
    }
    swap_bytes(base, base + j * sz, sz);          /* pivot into place at j */
    /* recurse into the smaller side, loop on the larger */
    size_t nl = j, nr = n - j - 1;
    if (nl < nr) { intro_sort(base, nl, sz, cmp, depth); base += (j + 1) * sz; n = nr; }
    else { intro_sort(base + (j + 1) * sz, nr, sz, cmp, depth); n = nl; }
  }
  insertion_sort(base, n, sz, cmp);
}

void __wrap_qsort(void *base, size_t n, size_t sz, cmp_fn cmp)
{
  if (n < 2 || sz == 0) return;
  int depth = 0;
  for (size_t k = n; k; k >>= 1) depth += 2;
  intro_sort((char *)base, n, sz, cmp, depth);
}

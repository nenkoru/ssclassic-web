/* Unit test for port/common/FastSort.c (the introsort the engine links as qsort).
 *
 * Every case sorts the same input with __wrap_qsort and with libc's qsort and checks that
 * - the keys come out in the same (sorted) order,
 * - the elements are a permutation of the input and each one is intact (payload bytes match its id),
 * - the number of comparisons stays O(n log n) (catches quadratic partitioning and a broken
 *   heapsort fallback).
 * Element sizes cover the 4/8-byte fast swaps (aligned and misaligned) and the byte-loop swap,
 * including elements larger than its 64-byte bounce buffer.
 *
 *   emcc -O2 tests/fastsort_test.c port/common/FastSort.c -o fastsort_test.js && node fastsort_test.js
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void __wrap_qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *));

static int failures, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { failures++; printf("FAIL  " __VA_ARGS__); printf("\n"); } } while (0)

/* --- deterministic PRNG (xorshift) --- */
static uint32_t rng = 2463534242u;
static uint32_t rnd(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }

/* --- elements: [int32 key][uint32 id][payload derived from id] in sz bytes (sz >= 8),
       or just an int32 key for sz == 4 --- */
static size_t g_sz;
static long g_cmps;
static int key_of(const void *p) { int k; memcpy(&k, p, 4); return k; }
static int cmp_key(const void *a, const void *b) { g_cmps++; int x = key_of(a), y = key_of(b); return (x > y) - (x < y); }
static int cmp_key_desc(const void *a, const void *b) { return -cmp_key(a, b); }
/* a comparator that ignores consistency: the sort must still terminate and stay in bounds */
static int cmp_random(const void *a, const void *b) { (void)a; (void)b; g_cmps++; return (int)(rnd() % 3) - 1; }

static void make_elem(unsigned char *p, int key, uint32_t id, size_t sz)
{
  memcpy(p, &key, 4);
  if (sz < 8) return;
  memcpy(p + 4, &id, 4);
  for (size_t i = 8; i < sz; i++) p[i] = (unsigned char)(id * 31u + i * 7u);
}
static int elem_ok(const unsigned char *p, size_t sz, uint32_t *id_out)
{
  if (sz < 8) { *id_out = 0; return 1; }
  uint32_t id; memcpy(&id, p + 4, 4);
  for (size_t i = 8; i < sz; i++) if (p[i] != (unsigned char)(id * 31u + i * 7u)) return 0;
  *id_out = id;
  return 1;
}

enum { RANDOM, FEW_KEYS, SORTED, REVERSED, ALL_EQUAL, ORGAN_PIPE, SAWTOOTH, NEARLY_SORTED, NPATTERNS };
static const char *pattern_name[] = { "random", "few-keys", "sorted", "reversed", "all-equal", "organ-pipe", "sawtooth", "nearly-sorted" };

static int gen_key(int pattern, size_t i, size_t n)
{
  switch (pattern) {
  case RANDOM: return (int)(rnd() & 0x7fffffff) - 0x3fffffff;
  case FEW_KEYS: return (int)(rnd() % 4);
  case SORTED: return (int)i;
  case REVERSED: return (int)(n - i);
  case ALL_EQUAL: return 7;
  case ORGAN_PIPE: return (int)(i < n / 2 ? i : n - i);
  case SAWTOOTH: return (int)(i % 17);
  default: return (int)i + ((rnd() % 20) == 0 ? (int)(rnd() % 50) - 25 : 0);
  }
}

/* sort a copy at a given byte offset (misalignment) with both sorts and compare */
static void run_case(int pattern, size_t n, size_t sz, size_t misalign)
{
  unsigned char *in = malloc(n * sz + 1), *raw = malloc(n * sz + 16), *ref = malloc(n * sz + 1);
  unsigned char *a = raw + misalign;
  for (size_t i = 0; i < n; i++) make_elem(in + i * sz, gen_key(pattern, i, n), (uint32_t)i, sz);
  memcpy(a, in, n * sz);
  memcpy(ref, in, n * sz);
  g_sz = sz;
  qsort(ref, n, sz, cmp_key);
  g_cmps = 0;
  __wrap_qsort(a, n, sz, cmp_key);
  long cmps = g_cmps;

  int order_ok = 1, intact = 1;
  for (size_t i = 0; i < n && order_ok; i++) order_ok = key_of(a + i * sz) == key_of(ref + i * sz);
  /* permutation: every id exactly once */
  unsigned char *seen = calloc(n ? n : 1, 1);
  for (size_t i = 0; i < n && intact; i++) {
    uint32_t id;
    if (!elem_ok(a + i * sz, sz, &id)) { intact = 0; break; }
    if (sz >= 8) {
      if (id >= n || seen[id]) { intact = 0; break; }
      seen[id] = 1;
      intact = key_of(a + i * sz) == key_of(in + (size_t)id * sz);
    }
  }
  double bound = n > 1 ? 4.0 * n * log2((double)n) + 64 : 64;
  CHECK(order_ok, "%-13s n=%-6zu sz=%-3zu +%zu: order differs from libc qsort", pattern_name[pattern], n, sz, misalign);
  CHECK(intact, "%-13s n=%-6zu sz=%-3zu +%zu: elements lost, duplicated or corrupted", pattern_name[pattern], n, sz, misalign);
  CHECK(cmps <= bound, "%-13s n=%-6zu sz=%-3zu +%zu: %ld comparisons (bound %.0f)", pattern_name[pattern], n, sz, misalign, cmps, bound);
  free(seen); free(in); free(raw); free(ref);
}

/* Median-of-three killer (Musser): makes plain median-of-3 quicksort quadratic; introsort must
   switch to heapsort and stay within O(n log n). */
static void run_m3_killer(size_t n)
{
  int *a = malloc(n * sizeof(int)), *ref = malloc(n * sizeof(int));
  size_t k = n / 2;
  for (size_t i = 1; i <= k; i++) {
    if (i % 2) { a[i - 1] = (int)i; a[i] = (int)(k + i); }
    a[k + i - 1] = (int)(2 * i);
  }
  memcpy(ref, a, n * sizeof(int));
  qsort(ref, n, sizeof(int), cmp_key);
  g_cmps = 0;
  __wrap_qsort(a, n, sizeof(int), cmp_key);
  CHECK(memcmp(a, ref, n * sizeof(int)) == 0, "m3-killer n=%zu: order differs", n);
  double bound = 4.0 * n * log2((double)n) + 64;
  CHECK(g_cmps <= bound, "m3-killer n=%zu: %ld comparisons (bound %.0f)", n, g_cmps, bound);
  free(a); free(ref);
}

int main(void)
{
  static const size_t sizes[] = { 0, 1, 2, 3, 15, 16, 17, 33, 100, 1000, 20000 };
  static const size_t elem_sizes[] = { 4, 8, 12, 24, 64, 100, 200 };
  for (int p = 0; p < NPATTERNS; p++)
    for (size_t si = 0; si < sizeof(sizes) / sizeof(*sizes); si++)
      for (size_t ei = 0; ei < sizeof(elem_sizes) / sizeof(*elem_sizes); ei++) {
        size_t n = sizes[si], sz = elem_sizes[ei];
        if (sz > 64 && n > 1000) continue;            /* large elements: keep the run quick */
        run_case(p, n, sz, 0);
        if (sz == 4 || sz == 8) run_case(p, n, sz, 1);   /* misaligned: the byte-loop swap path */
      }
  run_m3_killer(1000);
  run_m3_killer(100000);

  /* descending comparator */
  {
    int a[1000], ref[1000];
    for (int i = 0; i < 1000; i++) a[i] = ref[i] = (int)(rnd() % 100);
    qsort(ref, 1000, sizeof(int), cmp_key_desc);
    __wrap_qsort(a, 1000, sizeof(int), cmp_key_desc);
    CHECK(memcmp(a, ref, sizeof a) == 0, "descending comparator: order differs");
  }
  /* inconsistent comparator: must terminate, keep every element (no out-of-bounds writes) */
  {
    enum { N = 5000 };
    int *buf = malloc((N + 2) * sizeof(int)), *a = buf + 1;
    buf[0] = buf[N + 1] = 0x5eed;                     /* guards around the array */
    long sum = 0;
    for (int i = 0; i < N; i++) { a[i] = i; sum += i; }
    __wrap_qsort(a, N, sizeof(int), cmp_random);
    long sum2 = 0;
    unsigned char *seen = calloc(N, 1);
    int perm = 1;
    for (int i = 0; i < N; i++) { sum2 += a[i]; if (a[i] < 0 || a[i] >= N || seen[a[i]]++) perm = 0; }
    CHECK(perm && sum == sum2 && buf[0] == 0x5eed && buf[N + 1] == 0x5eed, "random comparator: elements lost or out-of-bounds write");
    free(seen); free(buf);
  }
  /* zero-size elements and NULL base with n == 0 are no-ops */
  {
    int x = 3;
    __wrap_qsort(&x, 1, 0, cmp_key);
    __wrap_qsort(NULL, 0, 4, cmp_key);
    CHECK(x == 3, "degenerate calls changed data");
  }

  printf("fastsort: %d/%d checks passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}

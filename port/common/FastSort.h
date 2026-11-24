/* FastSort.h: the introsort of FastSort.c (the qsort the web build links in, -Wl,--wrap=qsort) as a
 * C++ template, so a hot call site gets its comparator inlined instead of called through a pointer.
 *
 * It must stay step-for-step the same algorithm as FastSort.c: same pivot choice, same partition,
 * same insertion/heap sort thresholds and the same depth limit. Then it makes exactly the same
 * comparisons and swaps, so it leaves equal elements in the same order as qsort() would (qsort is
 * not stable; callers rely on getting the same order as before, e.g. frames stay bit-identical).
 * Keep the two files in sync.
 *
 *   se1_qsort(T *base, size_t n, cmp)   cmp(const T &a, const T &b) returns <0, 0, >0 like qsort's
 */
#ifndef SE1_FASTSORT_H
#define SE1_FASTSORT_H
#include <stddef.h>

namespace se1sort {

template<class T> static inline void Swap(T *a, T *b) { if (a == b) return; T t = *a; *a = *b; *b = t; }

template<class T, class Cmp>
static inline void InsertionSort(T *base, size_t n, Cmp &cmp)
{
  for (size_t i = 1; i < n; i++)
    for (size_t j = i; j > 0 && cmp(base[j - 1], base[j]) > 0; j--)
      Swap(base + j - 1, base + j);
}

template<class T, class Cmp>
static void SiftDown(T *base, size_t start, size_t n, Cmp &cmp)
{
  size_t root = start;
  for (;;) {
    size_t child = 2 * root + 1;
    if (child >= n) return;
    if (child + 1 < n && cmp(base[child], base[child + 1]) < 0) child++;
    if (cmp(base[root], base[child]) >= 0) return;
    Swap(base + root, base + child);
    root = child;
  }
}

template<class T, class Cmp>
static void HeapSort(T *base, size_t n, Cmp &cmp)
{
  for (size_t i = n / 2; i-- > 0;) SiftDown(base, i, n, cmp);
  for (size_t end = n; end-- > 1;) {
    Swap(base, base + end);
    SiftDown(base, 0, end, cmp);
  }
}

template<class T, class Cmp>
static void IntroSort(T *base, size_t n, Cmp &cmp, int depth)
{
  while (n > 16) {
    if (depth-- == 0) { HeapSort(base, n, cmp); return; }
    T *a = base, *b = base + n / 2, *c = base + n - 1;
    if (cmp(*b, *a) < 0) Swap(a, b);
    if (cmp(*c, *b) < 0) { Swap(b, c); if (cmp(*b, *a) < 0) Swap(a, b); }
    Swap(base, b);
    size_t i = 0, j = n;
    for (;;) {
      do i++; while (i < n && cmp(base[i], base[0]) < 0);
      do j--; while (j > 0 && cmp(base[j], base[0]) > 0);
      if (i >= j) break;
      Swap(base + i, base + j);
    }
    Swap(base, base + j);
    size_t nl = j, nr = n - j - 1;
    if (nl < nr) { IntroSort(base, nl, cmp, depth); base += j + 1; n = nr; }
    else { IntroSort(base + j + 1, nr, cmp, depth); n = nl; }
  }
  InsertionSort(base, n, cmp);
}

} // namespace se1sort

template<class T, class Cmp>
static inline void se1_qsort(T *base, size_t n, Cmp cmp)
{
  if (n < 2) return;
  int depth = 0;
  for (size_t k = n; k; k >>= 1) depth += 2;
  se1sort::IntroSort(base, n, cmp, depth);
}

#endif

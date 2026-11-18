# Upstream

`src/` is a vendored copy of [tx00100xt/serioussamclassic-vk](https://github.com/tx00100xt/serioussamclassic-vk)
(Serious Engine 1.10, GPL-2.0, originally released by Croteam), at commit
`510d36f901cbe883c56b155b53717e4efdeb6522` (2026-01-14, "Fix github action build").

- The first commit of this repository is that commit, unmodified.
- Our changes to `src/` are kept small and guarded by `__EMSCRIPTEN__`, `STATICALLY_LINKED` or
  `SE1_WITH_RUSTMOD`, so the native builds behave as before. `git log -p -- src` shows all of them.
- Generated files (entity C++ from `ecc`, flex/bison parsers) are not committed; see `tools/gen_entities.sh`.
- `upstream.git/` (not committed) holds the upstream clone's history for merging new upstream releases:
  `git --git-dir=upstream.git fetch` then diff against the vendored commit.

# Contributing

## Commit messages: Conventional Commits

Every commit uses [Conventional Commits](https://www.conventionalcommits.org/), so changelogs and
release notes can be generated automatically (e.g. release-please, git-cliff).

```
type(scope): short summary in the imperative

Optional body: what and why, measurements for perf changes.

Optional footers, e.g. BREAKING CHANGE: ...
```

| type       | use for                                                        |
|------------|----------------------------------------------------------------|
| `feat`     | a new user-visible capability (option, mod support, renderer)   |
| `fix`      | a bug fix                                                      |
| `perf`     | a measured speed-up (put the benchmark numbers in the body)    |
| `refactor` | code change with no behaviour change                           |
| `test`     | benchmarks, visual regression captures, test tooling          |
| `build`    | CMake, toolchain, dependencies                                 |
| `docs`     | notes/, README, comments-only changes                          |
| `chore`    | everything else (cleanups, repo housekeeping)                  |

Common scopes: `gl`, `webgpu`, `audio`, `engine`, `rust`, `bench`, `tools`, `build`, `data`.
Mark breaking changes with `!` (`feat(rust)!: ...`) or a `BREAKING CHANGE:` footer.

History before `c498280` predates this convention.

## Before you commit renderer or engine changes

- `node tools/bench.mjs <url> --shots <label>` then `python3 tools/shotdiff.py <reference> <label>`:
  the visual regression test must pass.
- `node tools/bench.mjs <url> 3`: the timedemo must not regress. Compare interleaved runs against the
  previous build, never across sessions.
- Upstream code under `src/` is patched minimally and guarded by `__EMSCRIPTEN__` /
  `STATICALLY_LINKED` / `SE1_WITH_RUSTMOD` (see UPSTREAM.md).

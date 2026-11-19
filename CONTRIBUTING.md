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

## Running the tests

`tools/test.sh` is the whole suite in one command; CI (`.github/workflows/ci.yml`) runs the same
script on every push, on a GPU-less Linux runner with SwiftShader.

```sh
source ~/emsdk/emsdk_env.sh                 # emsdk 7.0.0; Rust stable + nightly with rust-src
tools/test.sh                               # build what's missing, then run everything
tools/test.sh build-web-tfe-mt build-web-tfe-rel   # test existing builds (threaded, single-threaded) as they are
tools/test.sh --webgpu                      # local extra: WebGPU captures vs WebGL2 (skipped without WebGPU)
tools/test.sh --android                     # local extra: timedemo on a phone (needs ADB_SERIAL)
tests/run.sh                                # unit tests only (FastSort, CaseFs; emcc + Node)
```

Without build dirs, `tools/test.sh` bootstraps and builds `build-test-mt` and `build-test-st`:
the native entity compiler (`tools/build_ecc.sh`), the generated entity sources
(`tools/gen_entities.sh SamTFE`) and the free demo data (`tools/fetch_demo_data.sh`, checksum
verified, kept under the ignored `data/`). Each build is then served by `tools/devserver.py` and
checked with the flow test (`tools/flowtest.mjs`), two visual-regression captures that must match
each other (`tools/bench.mjs --shots` + `tools/shotdiff.py`), and one timedemo that must complete
with no frame over `SE1_MAX_FRAME_MS`. Results, logs and captures go to `data/test-results/`.

The browser tools read `CHROME` (binary), `SE1_ANGLE` (`metal` on macOS, `swiftshader` elsewhere),
`SE1_CHROME_FLAGS` and `SE1_TIMEOUT_SCALE` (see `tools/chrome.mjs`); to reproduce CI on a Mac, run
`SE1_ANGLE=swiftshader tools/test.sh`. The two builds render slightly differently by design (WASMFS vs
MEMFS animation phase), so their captures are never compared with each other.

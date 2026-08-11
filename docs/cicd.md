# CI/CD — Building & Releasing

Mantis builds on GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
across three GitHub-hosted runners — `windows-latest`, `ubuntu-latest`, and
`macos-latest` — and publishes to the
[Releases page](https://github.com/sp00nznet/mantis/releases) on a version tag.

There is nothing to maintain: no self-hosted runners, no share to mount, no
service accounts. The workflow installs what it needs per run.

## What gets built

**CLI** — `mantis` / `mantis.exe` via Node 22 Single Executable Applications
(SEA). One binary with Node bundled in, no runtime needed on the target machine.

| Asset | Notes |
|---|---|
| `Mantis-CLI-<v>-windows-x64.zip` | binary + sidecar files, run in place |
| `Mantis-CLI-Setup-<v>.exe` | NSIS, installs to `%ProgramFiles%\Mantis\`, adds to PATH, appears in Add/Remove Programs |
| `Mantis-CLI-<v>-linux-x64.tar.gz` | run in place |
| `mantis-cli_<v>_amd64.deb` | `/usr/local/share/mantis/`, symlinks `/usr/local/bin/mantis` |
| `Mantis-CLI-<v>-macos-{arm64,x64}.tar.gz` | run in place |
| `Mantis-CLI-<v>-macos-{arm64,x64}.pkg` | same layout as the `.deb` |

**Desktop** — `electron-builder` output:

| Asset | Notes |
|---|---|
| `Mantis-Desktop-Setup-<v>-win-x64.exe` | NSIS installer |
| `Mantis-Desktop-<v>-win-x64-portable.exe` | portable |
| `Mantis-Desktop-<v>-mac-{arm64,x64}.dmg` | unsigned — Gatekeeper warns on first launch |
| `Mantis-Desktop-<v>-linux-x86_64.AppImage` | |
| `Mantis-Desktop-<v>-linux-amd64.deb` | |

14 assets per release.

## Cutting a release

```bash
# 1. Bump the one version that matters.
#    desktop/package.json is derived from it — do not edit it by hand.
npm version 3.7.0 --no-git-tag-version
git commit -am "release: v3.7.0"
git push

# 2. Wait for the push build to go green (it builds everything, publishes nothing).

# 3. Tag it. This is what publishes.
git tag -a v3.7.0 -m "v3.7.0"
git push origin v3.7.0
```

The `release` job attaches all 14 assets and writes the release notes from the
commits since the last tag (`generate_release_notes`).

**Root `package.json` is the single source of truth for the version.** It is
compiled into the binary (`mantis version`), it names every asset, and
`scripts/sync-version.mjs` stamps it into `desktop/package.json` before
electron-builder runs — otherwise the desktop assets ship under a different
number than the CLI ones in the same release. The `check` job fails a tag that
disagrees with `package.json`, so `v3.7.0` can never contain 3.6.0 files.

## Pipeline structure

```
check  →  windows · linux · macos  →  release
```

| Job | Runs on | What it does |
|---|---|---|
| `check` | ubuntu | Tag/version guard, `mantis version`, `mantis help`, `npm test` |
| `windows` | windows-latest | SEA + NSIS installer + desktop, uploads `releases/` |
| `linux` | ubuntu-latest | SEA + `.deb` + desktop, uploads `releases/` |
| `macos` | macos-latest | SEA ×2 arches + `.pkg` ×2 + desktop, uploads `releases/` |
| `release` | ubuntu | Downloads all three, publishes to the Releases page |

Triggers: pushes to `main`, `v*` tags, pull requests, and manual dispatch.
**Only a `v*` tag publishes** — everything else builds and stops, which makes a
push to `main` a free rehearsal for the release.

`release` is a separate job rather than each platform attaching its own files:
three jobs writing one release race each other, and a macOS failure would
otherwise leave a half-published release on the page.

### Things worth knowing about the jobs

- **macOS builds both CLI arches from one arm64 runner.** `build-sea.mjs`
  downloads the target's Node when `TARGET_ARCH` differs from the host, and
  postject and `codesign` both handle a Mach-O of either arch.
- **`macos-latest` is arm64.** Anything that takes its architecture from the
  host silently drops Intel — `dist:mac` passes `--x64 --arm64` explicitly for
  exactly this reason.
- **Windows installs NSIS per run** (`choco install nsis`) and hands the path
  forward via `GITHUB_PATH`; choco's own PATH edit does not reach later steps in
  the same job.
- **Linux builds the SEA natively.** The old GitLab pipeline cross-built it on
  macOS because that debian runner OOMed during postject; GitHub's ubuntu runner
  has the headroom. If it ever regresses, set `TARGET_PLATFORM=linux` and move
  the step to the macos job.
- **Each job runs `ls -lh releases/` before uploading.** `tar` and `mv` print
  nothing, so without it a missing asset looks exactly like a green build.

## Building locally

```bash
# CLI single-exe — needs Node 22+ on PATH
npm install                  # gets esbuild + postject
npm run build:sea            # writes dist/release/mantis(.exe) + sidecar files

# CLI native installer (NSIS / pkg / deb, picks the host platform)
npm run build:installer      # writes dist/Mantis-CLI-{Setup-,}<version>.{exe,pkg,deb}

# Both in one shot
npm run build:all

# Desktop installer
cd desktop
npm install
npm run dist                 # outputs desktop/dist/<installer>
```

`build:installer` needs a native packaging tool on the host: NSIS on Windows
(`winget install NSIS.NSIS` / `choco install nsis`), `pkgbuild` on macOS (built
in), `dpkg-deb` on Linux (`sudo apt install -y dpkg`).

## Code signing

Builds are **currently unsigned**. Users will see:
- Windows: SmartScreen "Unrecognized app — Run anyway"
- macOS: Gatekeeper "Cannot be opened because the developer cannot be verified"
- Linux: no warning (signing not expected on Linux)

To enable signing later, add repository **secrets** and reference them as `env`
on the packaging steps:

- **Windows**: `WIN_CSC_LINK` (base64 `.pfx` or URL) and `WIN_CSC_KEY_PASSWORD`.
  electron-builder picks them up automatically; the CLI's NSIS installer needs a
  separate `signtool` call.
- **macOS**: `CSC_LINK`, `CSC_KEY_PASSWORD`, plus `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for notarization.

## What's in v3.6 (the current build)

- Swarm-by-default everywhere, with three off-switches — see [Swarm Mode](swarm.md)
- Auto-pick provider with saved key at startup (no more dead-ends on missing Ollama)
- Local backend URLs in desktop Settings (Ollama / LM Studio / llama.cpp)
- Three image-gen backends — NVIDIA NIM, Automatic1111, OpenAI-compat — see [Tools](tools.md#generate_image)

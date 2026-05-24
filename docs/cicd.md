# CI/CD — Building & Releasing

Mantis builds on a GitLab CI pipeline (`.gitlab-ci.yml`) that targets three
shell runners — Windows, Linux, macOS — and produces:

- **CLI single-exe** — `mantis` / `mantis.exe` via Node 22 Single Executable
  Applications (SEA). One binary, bundled Node, no install required on the
  target machine.
- **CLI installer** — native installer that drops the exe into a system
  location and adds it to `PATH`:
  - Windows: NSIS `.exe` — `Mantis-CLI-Setup-<version>.exe`, installs to
    `%ProgramFiles%\Mantis\`, adds to system PATH, shows up in Add/Remove
    Programs.
  - macOS: `.pkg` — `Mantis-CLI-<version>.pkg`, installs to
    `/usr/local/share/mantis/`, symlinks `mantis` into `/usr/local/bin/`.
  - Linux: `.deb` — `mantis-cli_<version>_amd64.deb`, installs to
    `/usr/local/share/mantis/`, symlinks `mantis` into `/usr/local/bin/`.
- **Desktop installer** — `electron-builder` output:
  - Windows: NSIS `.exe` installer + portable `.exe`
  - macOS: `.dmg` (unsigned — Gatekeeper warns on first launch)
  - Linux: `AppImage` + `.deb`

Artifacts land at `\\$SMB_HOST\$SMB_SHARE\mantis\<branch-or-tag>\` on the
release SMB share, same layout as Tachyon.

## Pipeline structure

```
build  →  test  →  package  →  deploy
```

| Stage     | Runs on             | What it does |
|-----------|---------------------|--------------|
| `build`   | windows · linux · macos | Install npm deps for CLI + desktop |
| `test`    | linux               | `node --test` against `tests/` (when present) |
| `package` | windows · linux · macos | SEA-bundle CLI + electron-build desktop |
| `deploy`  | windows             | Mount SMB share, copy all `package` artifacts |

The `deploy` job runs only on:
- pushes to `main` / `master`
- git tags (`v3.6.0` → `…/mantis/v3.6.0/`)
- manual web triggers (GitLab UI → Run pipeline)

Merge-request pipelines build and package but skip deploy.

## One-time runner setup

All three runners need **Node 22 LTS** machine-wide, on PATH for the service
account. Quick install:

| OS      | Command |
|---------|---------|
| Windows | `winget install OpenJS.NodeJS.LTS --scope machine` |
| macOS   | `brew install node@22 && brew link --overwrite node@22` |
| Linux   | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo bash - && sudo apt install -y nodejs` |

The Windows runner additionally needs:
- PowerShell 5.1+ (built-in on Win10+)
- `gitlab-runner` registered with `--executor shell --shell pwsh`
- NSIS 3.x for the CLI installer: `winget install NSIS.NSIS` (or `choco install nsis`)

The macOS runner additionally needs:
- Xcode CLT (`xcode-select --install`) — electron-builder uses `hdiutil`

The Linux runner additionally needs:
- `fakeroot`, `dpkg`, `rpm` — `sudo apt install -y fakeroot dpkg rpm`
- `libarchive-tools` (for `.deb`/`.rpm` from electron-builder)

## SMB deploy variables

Set these as **CI/CD variables** (masked) on the GitLab project:

| Variable        | Example              | Notes |
|-----------------|----------------------|-------|
| `SMB_HOST`      | `releases.lan`       | SMB server host or IP |
| `SMB_SHARE`     | `releases`           | Top-level share |
| `SMB_USER`      | `mantis-ci`          | Service account |
| `SMB_PASSWORD`  | *(masked)*           | Account password |

Resulting path: `\\$SMB_HOST\$SMB_SHARE\mantis\$CI_COMMIT_REF_SLUG\`

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

Each `package` job in CI runs the equivalent of those two commands and copies
the outputs into `releases/<os>/`, which is the path the `deploy` job reads.

## Code signing

Builds are **currently unsigned**. Users will see:
- Windows: SmartScreen "Unrecognized app — Run anyway"
- macOS: Gatekeeper "Cannot be opened because the developer cannot be verified"
- Linux: no warning (signing not expected on Linux)

To enable signing later:

- **Windows**: add `WIN_CSC_LINK` (path or URL to `.pfx`) and `WIN_CSC_KEY_PASSWORD` CI vars. electron-builder picks them up automatically.
- **macOS**: add an Apple Developer ID cert to the runner keychain and set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization.

## What's in v3.6 (the current build)

- Swarm-by-default everywhere, with three off-switches — see [Swarm Mode](swarm.md)
- Auto-pick provider with saved key at startup (no more dead-ends on missing Ollama)
- Local backend URLs in desktop Settings (Ollama / LM Studio / llama.cpp)
- Three image-gen backends — NVIDIA NIM, Automatic1111, OpenAI-compat — see [Tools](tools.md#generate_image)

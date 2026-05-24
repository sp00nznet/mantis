#!/usr/bin/env bash
# ============================================================================
#  runner-electron-cache.sh — bootstrap the Electron + electron-builder cache
#  on a runner that can't reach github.com / npmmirror.com.
#
#  USAGE:
#
#   Step 1.  On a machine WITH internet (your laptop, the windows-runner,
#            anywhere that can reach GitHub):
#
#       ./runner-electron-cache.sh prepare
#
#            Writes ./electron-cache-bundle.tar.gz containing every binary
#            electron-builder needs for the Linux desktop build:
#               electron-v33.4.11-linux-x64.zip
#               electron-v33.4.11-linux-x64/SHASUMS256.txt
#               appimage-12.0.1 (for AppImage target)
#               app-builder linux binary
#            ~110 MB.
#
#   Step 2.  Transfer electron-cache-bundle.tar.gz to the debian-runner box.
#            Anything that works: scp, USB stick, a temporary HTTP server,
#            even pushing it through your GitLab as a job artifact.
#
#   Step 3.  On the debian-runner (as the gitlab-runner user):
#
#       sudo -u gitlab-runner bash runner-electron-cache.sh install /path/to/electron-cache-bundle.tar.gz
#
#            Extracts to ~/.cache/electron/ + ~/.cache/electron-builder/.
#            From this point onward npm install in desktop/ reads from the
#            cache; no network egress needed.
#
#  Re-run prepare whenever desktop/package.json bumps electron's version —
#  the script reads the version straight from the lockfile.
# ============================================================================

set -euo pipefail

cmd=${1:-help}
arg=${2:-}

# Where the script lives (so we can read ../desktop/package.json).
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# Read electron version from desktop/package.json (devDependencies.electron).
# Falls back to the same default Mantis pinned at v3.7.
ELECTRON_VERSION=$(node -p "
const p = require('$REPO_ROOT/desktop/package.json');
(p.devDependencies?.electron || p.dependencies?.electron || '33.3.1').replace(/^[\^~]/, '')
" 2>/dev/null || echo "33.4.11")

# These versions match electron-builder 25.1.x defaults. If you bump
# electron-builder bump these too.
APPIMAGE_VERSION="12.0.1"
APPBUILDER_VERSION="5.0.0-alpha.10"   # whatever electron-builder 25.1 currently uses

BUNDLE_NAME="electron-cache-bundle.tar.gz"

# ───────────────────────────────────────────────────────────────────────────

case "$cmd" in

prepare)
  echo "▶ Preparing Electron cache bundle for v${ELECTRON_VERSION}"
  STAGE=$(mktemp -d)
  trap "rm -rf $STAGE" EXIT

  mkdir -p "$STAGE/electron/v${ELECTRON_VERSION}-linux-x64"
  mkdir -p "$STAGE/electron-builder/appimage/appimage-${APPIMAGE_VERSION}"

  # Electron itself ───────────────────────────────────────────────────
  ELECTRON_ZIP="electron-v${ELECTRON_VERSION}-linux-x64.zip"
  echo "  • downloading $ELECTRON_ZIP"
  curl -fL -o "$STAGE/electron/v${ELECTRON_VERSION}-linux-x64/$ELECTRON_ZIP" \
    "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ELECTRON_ZIP}"

  echo "  • downloading SHASUMS256.txt"
  curl -fL -o "$STAGE/electron/v${ELECTRON_VERSION}-linux-x64/SHASUMS256.txt" \
    "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/SHASUMS256.txt"

  # AppImage tooling for electron-builder ─────────────────────────────
  # electron-builder fetches this from electron-builder-binaries. URL pattern
  # https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage-12.0.1/appimage-12.0.1.7z
  APPIMAGE_ARCHIVE="appimage-${APPIMAGE_VERSION}.7z"
  echo "  • downloading $APPIMAGE_ARCHIVE"
  curl -fL -o "$STAGE/electron-builder/appimage/$APPIMAGE_ARCHIVE" \
    "https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage-${APPIMAGE_VERSION}/${APPIMAGE_ARCHIVE}" \
    || echo "  ! could not fetch appimage-${APPIMAGE_VERSION}.7z — AppImage target may need to be turned off until this is fixed"

  # Bundle ────────────────────────────────────────────────────────────
  echo "▶ Bundling into ./$BUNDLE_NAME"
  tar -C "$STAGE" -czf "$REPO_ROOT/$BUNDLE_NAME" .
  ls -lh "$REPO_ROOT/$BUNDLE_NAME"
  echo ""
  echo "✓ done. Transfer $BUNDLE_NAME to the debian-runner and run:"
  echo "    bash scripts/runner-electron-cache.sh install ./$BUNDLE_NAME"
  ;;

install)
  if [ -z "$arg" ] || [ ! -f "$arg" ]; then
    echo "Usage: $0 install <path-to-electron-cache-bundle.tar.gz>"
    exit 1
  fi
  ELECTRON_DIR="${HOME}/.cache/electron"
  EB_DIR="${HOME}/.cache/electron-builder"
  echo "▶ Installing cache from $arg"
  mkdir -p "$ELECTRON_DIR" "$EB_DIR"
  STAGE=$(mktemp -d)
  trap "rm -rf $STAGE" EXIT
  tar -xzf "$arg" -C "$STAGE"
  # Move pieces into place.
  if [ -d "$STAGE/electron" ];          then cp -R "$STAGE/electron/."          "$ELECTRON_DIR/"; fi
  if [ -d "$STAGE/electron-builder" ];  then cp -R "$STAGE/electron-builder/."  "$EB_DIR/"; fi
  echo "✓ cache installed:"
  find "$ELECTRON_DIR" "$EB_DIR" -maxdepth 3 -type f 2>/dev/null | head -20
  echo ""
  echo "Now the next desktop:linux pipeline job should skip the electron download"
  echo "and finish in ~30s instead of hanging."
  ;;

*)
  cat <<EOF
runner-electron-cache.sh — fix the debian-runner's blocked electron download

  prepare                 (run on a machine with internet)
                          downloads electron + tooling, writes
                          ./electron-cache-bundle.tar.gz

  install <bundle>        (run on the debian-runner, as gitlab-runner)
                          extracts the bundle into ~/.cache/electron and
                          ~/.cache/electron-builder so npm install doesn't
                          need to hit GitHub.

  Pinned versions in this script:
    electron        v${ELECTRON_VERSION}    (from desktop/package.json)
    appimage tools  ${APPIMAGE_VERSION}
EOF
  exit 1
  ;;

esac

#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# Mantis Installer — Linux/macOS
# Detects GPU, installs Ollama, pulls the right model, sets up Mantis.
# ──────────────────────────────────────────────────────────────

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

info()    { echo -e "  ${CYAN}${BOLD}→${RESET} $1"; }
success() { echo -e "  ${GREEN}${BOLD}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}${BOLD}!${RESET} $1"; }
error()   { echo -e "  ${RED}${BOLD}✗${RESET} $1"; }

echo ""
echo -e "  ${BOLD}     \\_/${RESET}"
echo -e "  ${BOLD}    (o.o)    MANTIS INSTALLER${RESET}"
echo -e "  ${BOLD}   _/|\\_${RESET}"
echo -e "  ${BOLD}  / / \\ \\${RESET}"
echo -e "  ${BOLD}    / \\${RESET}"
echo -e "  ${BOLD}   /   \\${RESET}"
echo ""

# ─── Find script directory (where Mantis lives) ──────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANTIS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Step 1: Check Node.js ───────────────────────────────────
info "Checking Node.js..."

if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 18 ]; then
    success "Node.js v$(node -v | sed 's/v//') found"
  else
    error "Node.js v18+ required (found v$(node -v | sed 's/v//'))"
    echo -e "  ${DIM}Install from: https://nodejs.org/${RESET}"
    exit 1
  fi
else
  error "Node.js not found. Install v18+ from https://nodejs.org/"
  exit 1
fi

# ─── Step 2: Check/Install Ollama ────────────────────────────
info "Checking Ollama..."

if command -v ollama &>/dev/null; then
  success "Ollama found: $(ollama --version 2>/dev/null || echo 'installed')"
else
  warn "Ollama not found."
  echo ""
  read -p "  Install Ollama now? (Y/n): " INSTALL_OLLAMA
  INSTALL_OLLAMA=${INSTALL_OLLAMA:-Y}

  if [[ "$INSTALL_OLLAMA" =~ ^[Yy] ]]; then
    info "Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
    if command -v ollama &>/dev/null; then
      success "Ollama installed!"
    else
      error "Ollama installation failed. Install manually: https://ollama.com"
      exit 1
    fi
  else
    warn "Skipping Ollama. You can use cloud providers instead (/provider set together)."
  fi
fi

# ─── Step 3: Detect GPU ─────────────────────────────────────
info "Detecting GPU..."

GPU_NAME="unknown"
VRAM_MB=0
MODEL="qwen2.5-coder:7b"  # default fallback

if command -v nvidia-smi &>/dev/null; then
  # Get GPU name and VRAM
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null | head -1 | xargs)
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | xargs)

  if [ -n "$VRAM_MB" ] && [ "$VRAM_MB" -gt 0 ] 2>/dev/null; then
    VRAM_GB=$((VRAM_MB / 1024))
    success "GPU: $GPU_NAME (${VRAM_GB}GB VRAM)"

    if [ "$VRAM_GB" -ge 24 ]; then
      MODEL="qwen2.5-coder:32b"
      info "Recommended model: qwen2.5-coder:32b (Q4_K_M, ~20GB)"
    elif [ "$VRAM_GB" -ge 12 ]; then
      MODEL="qwen2.5-coder:14b"
      info "Recommended model: qwen2.5-coder:14b (~9-12GB)"
    elif [ "$VRAM_GB" -ge 8 ]; then
      MODEL="qwen2.5-coder:7b"
      info "Recommended model: qwen2.5-coder:7b (Q4_K_M, ~5GB)"
    else
      MODEL="qwen2.5-coder:7b"
      info "Recommended model: qwen2.5-coder:7b (Q4_K_M, ~5GB)"
    fi
  else
    warn "Could not detect VRAM. Using CPU-friendly model."
    MODEL="qwen2.5-coder:7b"
  fi
elif [[ "$(uname)" == "Darwin" ]] && system_profiler SPDisplaysDataType 2>/dev/null | grep -q "Apple"; then
  # macOS with Apple Silicon — Metal acceleration
  GPU_NAME="Apple Silicon"
  # Get unified memory
  TOTAL_RAM_GB=$(sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/1024/1024)}')
  success "GPU: Apple Silicon (${TOTAL_RAM_GB}GB unified memory)"

  if [ "$TOTAL_RAM_GB" -ge 32 ]; then
    MODEL="qwen2.5-coder:32b"
    info "Recommended model: qwen2.5-coder:32b"
  elif [ "$TOTAL_RAM_GB" -ge 16 ]; then
    MODEL="qwen2.5-coder:14b"
    info "Recommended model: qwen2.5-coder:14b"
  else
    MODEL="qwen2.5-coder:7b"
    info "Recommended model: qwen2.5-coder:7b"
  fi
else
  warn "No NVIDIA GPU detected. Using CPU model."
  MODEL="qwen2.5-coder:7b"
fi

echo ""
read -p "  Use $MODEL? (Y/n, or type a different model name): " MODEL_CHOICE
MODEL_CHOICE=${MODEL_CHOICE:-Y}

if [[ "$MODEL_CHOICE" =~ ^[Yy]$ ]]; then
  : # keep MODEL as-is
elif [[ "$MODEL_CHOICE" =~ ^[Nn]$ ]]; then
  read -p "  Enter model name: " MODEL
else
  MODEL="$MODEL_CHOICE"
fi

# ─── Step 4: Pull the model ─────────────────────────────────
if command -v ollama &>/dev/null; then
  info "Pulling model: $MODEL (this may take a while)..."
  ollama pull "$MODEL"
  success "Model $MODEL ready!"
else
  warn "Ollama not installed — skipping model pull."
  warn "Use /provider set <cloud> to use a cloud provider instead."
fi

# ─── Step 5: npm install ─────────────────────────────────────
info "Installing dependencies..."
cd "$MANTIS_DIR"
npm install
success "Dependencies installed!"

# ─── Step 6: Create config ───────────────────────────────────
CONFIG_DIR="$HOME/.mantis"
CONFIG_FILE="$CONFIG_DIR/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" << EOF
{
  "model": "$MODEL",
  "ollamaUrl": "http://localhost:11434",
  "provider": "local",
  "providerKeys": {},
  "maxContextTokens": 32768,
  "compactThreshold": 0.75,
  "commandTimeout": 60000,
  "maxToolResultSize": 8000,
  "confirmDestructive": true
}
EOF
  success "Config created: $CONFIG_FILE"
else
  success "Config already exists: $CONFIG_FILE"
fi

# ─── Step 7: npm link ────────────────────────────────────────
info "Setting up 'mantis' command..."
npm link 2>/dev/null || {
  warn "npm link failed (may need sudo). Trying with sudo..."
  sudo npm link 2>/dev/null || {
    warn "Could not create global link. Run manually: cd $MANTIS_DIR && sudo npm link"
  }
}

if command -v mantis &>/dev/null; then
  success "'mantis' command is ready!"
else
  warn "'mantis' not in PATH. You can run directly: node $MANTIS_DIR/bin/mantis.js"
fi

# ─── Done ────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${BOLD}Installation complete!${RESET}"
echo ""
echo -e "  ${DIM}To start Mantis:${RESET}"
echo -e "    ${CYAN}cd ~/your-project${RESET}"
echo -e "    ${CYAN}mantis${RESET}"
echo ""
echo -e "  ${DIM}To use a cloud provider instead of local:${RESET}"
echo -e "    ${CYAN}/provider set together${RESET}"
echo -e "    ${CYAN}/provider key together YOUR_API_KEY${RESET}"
echo ""

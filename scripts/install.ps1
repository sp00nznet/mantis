# ──────────────────────────────────────────────────────────────
# Mantis Installer — Windows PowerShell
# Detects GPU, installs Ollama, pulls the right model, sets up Mantis.
# ──────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

function Write-Info($msg)    { Write-Host "  → $msg" -ForegroundColor Cyan }
function Write-Success($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "  ✗ $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "       \_/"           -ForegroundColor White
Write-Host "      (o.o)    MANTIS INSTALLER" -ForegroundColor White
Write-Host "     _/|\_"           -ForegroundColor White
Write-Host "    / / \ \"          -ForegroundColor White
Write-Host "      / \"            -ForegroundColor White
Write-Host "     /   \"           -ForegroundColor White
Write-Host ""

# ─── Find script directory ───────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MantisDir = Split-Path -Parent $ScriptDir

# ─── Step 1: Check Node.js ───────────────────────────────────
Write-Info "Checking Node.js..."

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVersion = (node -v) -replace 'v', ''
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -ge 18) {
        Write-Success "Node.js v$nodeVersion found"
    } else {
        Write-Err "Node.js v18+ required (found v$nodeVersion)"
        Write-Host "  Install from: https://nodejs.org/" -ForegroundColor DarkGray
        exit 1
    }
} else {
    Write-Err "Node.js not found. Install v18+ from https://nodejs.org/"
    exit 1
}

# ─── Step 2: Check/Install Ollama ────────────────────────────
Write-Info "Checking Ollama..."

$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaCmd) {
    Write-Success "Ollama found"
} else {
    Write-Warn "Ollama not found."
    $installOllama = Read-Host "  Install Ollama now? (Y/n)"
    if (-not $installOllama -or $installOllama -match '^[Yy]') {
        Write-Info "Downloading Ollama installer..."
        $installerPath = "$env:TEMP\OllamaSetup.exe"
        try {
            Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $installerPath
            Write-Info "Running Ollama installer..."
            Start-Process -FilePath $installerPath -Wait
            # Refresh PATH
            $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
            $ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
            if ($ollamaCmd) {
                Write-Success "Ollama installed!"
            } else {
                Write-Warn "Ollama installed but not in PATH yet. Restart your terminal after setup."
            }
        } catch {
            Write-Err "Failed to download Ollama. Install manually: https://ollama.com"
        }
    } else {
        Write-Warn "Skipping Ollama. Use cloud providers instead (/provider set together)."
    }
}

# ─── Step 3: Detect GPU ─────────────────────────────────────
Write-Info "Detecting GPU..."

$gpuName = "unknown"
$vramMB = 0
$model = "qwen2.5-coder:7b"  # default

try {
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        $gpuInfo = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
        if ($gpuInfo) {
            $parts = $gpuInfo.Trim().Split(',')
            $gpuName = $parts[0].Trim()
            $vramMB = [int]$parts[1].Trim()
            $vramGB = [math]::Floor($vramMB / 1024)

            Write-Success "GPU: $gpuName (${vramGB}GB VRAM)"

            if ($vramGB -ge 24) {
                $model = "qwen2.5-coder:32b"
                Write-Info "Recommended model: qwen2.5-coder:32b (Q4_K_M, ~20GB)"
            } elseif ($vramGB -ge 12) {
                $model = "qwen2.5-coder:14b"
                Write-Info "Recommended model: qwen2.5-coder:14b (~9-12GB)"
            } elseif ($vramGB -ge 8) {
                $model = "qwen2.5-coder:7b"
                Write-Info "Recommended model: qwen2.5-coder:7b (Q4_K_M, ~5GB)"
            } else {
                $model = "qwen2.5-coder:7b"
                Write-Info "Recommended model: qwen2.5-coder:7b (Q4_K_M, ~5GB)"
            }
        }
    } else {
        Write-Warn "No NVIDIA GPU detected. Using CPU-friendly model."
    }
} catch {
    Write-Warn "GPU detection failed. Using CPU-friendly model."
}

Write-Host ""
$modelChoice = Read-Host "  Use $model? (Y/n, or type a different model name)"

if (-not $modelChoice -or $modelChoice -match '^[Yy]$') {
    # keep model as-is
} elseif ($modelChoice -match '^[Nn]$') {
    $model = Read-Host "  Enter model name"
} else {
    $model = $modelChoice
}

# ─── Step 4: Pull the model ─────────────────────────────────
$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaCmd) {
    Write-Info "Pulling model: $model (this may take a while)..."
    ollama pull $model
    Write-Success "Model $model ready!"
} else {
    Write-Warn "Ollama not available — skipping model pull."
    Write-Warn "Use /provider set <cloud> to use a cloud provider instead."
}

# ─── Step 5: npm install ─────────────────────────────────────
Write-Info "Installing dependencies..."
Push-Location $MantisDir
npm install
Write-Success "Dependencies installed!"

# ─── Step 6: Create config ───────────────────────────────────
$configDir = Join-Path $env:USERPROFILE ".mantis"
$configFile = Join-Path $configDir "config.json"

if (-not (Test-Path $configFile)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    $config = @{
        model = $model
        ollamaUrl = "http://localhost:11434"
        provider = "local"
        providerKeys = @{}
        maxContextTokens = 32768
        compactThreshold = 0.75
        commandTimeout = 60000
        maxToolResultSize = 8000
        confirmDestructive = $true
    } | ConvertTo-Json -Depth 3
    Set-Content -Path $configFile -Value $config -Encoding UTF8
    Write-Success "Config created: $configFile"
} else {
    Write-Success "Config already exists: $configFile"
}

# ─── Step 7: npm link ────────────────────────────────────────
Write-Info "Setting up 'mantis' command..."
try {
    npm link 2>$null
    Write-Success "'mantis' command is ready!"
} catch {
    Write-Warn "npm link failed. You may need to run as Administrator."
    Write-Warn "Or run directly: node $MantisDir\bin\mantis.js"
}

Pop-Location

# ─── Done ────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  To start Mantis:" -ForegroundColor DarkGray
Write-Host "    cd ~\your-project" -ForegroundColor Cyan
Write-Host "    mantis" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To use a cloud provider instead of local:" -ForegroundColor DarkGray
Write-Host "    /provider set together" -ForegroundColor Cyan
Write-Host "    /provider key together YOUR_API_KEY" -ForegroundColor Cyan
Write-Host ""

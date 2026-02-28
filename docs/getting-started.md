# Getting Started

Welcome! This guide will get you from zero to a working AI coding assistant in about 5 minutes.

---

## What You're Setting Up

Mantis is three things working together:

1. **Ollama** — Runs AI models on your machine (like Docker, but for AI)
2. **Qwen3-Coder** — The AI model that understands code (lives inside Ollama)
3. **Mantis** — The agent layer that gives the model hands (reads files, writes code, runs commands)

The installer sets up all three. But if you like doing things manually, read on.

---

## Automatic Install

### Windows

Option A — Double-click `installer\install.bat`

Option B — PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File installer\install-windows.ps1
```

### Linux (Debian/Ubuntu)

```bash
chmod +x installer/install-linux.sh
./installer/install-linux.sh
```

### What the installer does

1. Asks where you want to install (default: `~/mantis`)
2. Asks CPU or GPU mode
3. Checks for Ollama — installs it if missing
4. Checks for Node.js v18+ — installs it if missing
5. Copies the project files and runs `npm install`
6. Links `mantis` as a global command
7. Pulls the AI model from Ollama's registry
8. Done!

---

## Manual Install

### Prerequisites

**Ollama:**
```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows — download from https://ollama.com/download
```

**Node.js v18+:**
```bash
# Check if you have it
node --version

# If not, grab it from https://nodejs.org
```

### Install Mantis

```bash
# Clone or copy the project
cd mantis

# Install dependencies
npm install

# Link as a global command
npm link

# Pull the model (pick one)
ollama pull qwen3-coder-cpu   # CPU mode
ollama pull qwen3-coder       # GPU mode (needs NVIDIA + CUDA)
```

### Verify it works

```bash
# Make sure Ollama is running
ollama serve &

# Test the model
ollama run qwen3-coder-cpu "Say hello"

# Launch Mantis
mantis
```

---

## Your First Session

Open a terminal, navigate to any project, and start:

```bash
cd ~/my-project
mantis
```

You'll see the welcome screen. Try these in order:

### 1. Look around

```
> What files are in this project?
```

The model will use `list_files` to explore the directory and describe what it finds.

### 2. Read something

```
> Read the main entry point and explain how it works
```

It'll find and read the likely entry point (index.js, main.py, etc.) and explain the code.

### 3. Search for something

```
> Find all TODO comments in the codebase
```

It'll use `search_files` with a regex pattern and report what it finds.

### 4. Make a change

```
> Create a file called hello.txt that says "Mantis was here"
```

It'll use `write_file` to create the file. Check — it's really there.

### 5. Run a command

```
> Run git status
```

It'll execute the command and show you the output.

---

### 6. Try a skill

```
> /init
```

The `/init` skill explores the project and gives you a complete summary — structure, tech stack, how to build and test.

```
> /commit Added hello.txt
```

The `/commit` skill stages, writes a commit message, and commits — all automatically.

---

## What's Next

- Try the built-in [Skills](skills.md) — `/commit`, `/test`, `/review`, `/explain`, and more
- Learn about [Plan Mode](plan-mode.md) for exploring before making changes
- See all [Tools](tools.md) the model can use
- Understand [Context Management](context-management.md) for long sessions
- Customize your [Configuration](configuration.md)
- Peek under the hood at the [Architecture](architecture.md)

---

## Troubleshooting

### "Failed to connect to Ollama"

Ollama isn't running. Start it:
```bash
ollama serve          # Linux
# Windows: Ollama runs as a system service — check the tray icon
```

### "mantis: command not found"

The global link didn't stick. Try:
```bash
# Option 1: Re-link
cd ~/mantis && npm link

# Option 2: Run directly
node ~/mantis/bin/mantis.js
```

### Model is slow

- CPU mode is inherently slower. That's the trade-off for running locally without a GPU.
- Close other heavy applications to free up RAM.
- If you have an NVIDIA GPU, switch to GPU mode: `ollama pull qwen3-coder` then `/model qwen3-coder`

### "Model not found"

Pull the model first:
```bash
ollama pull qwen3-coder-cpu
```

Check what you have:
```bash
ollama list
```

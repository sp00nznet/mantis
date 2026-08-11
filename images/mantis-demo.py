#!/usr/bin/env python3
"""Regenerate the README demos — images/mantis-demo.gif and mantis-swarm.gif.

    pip install pillow
    git clone https://github.com/sp00nznet/termshot
    PYTHONPATH=../termshot python3 images/mantis-demo.py

Every line here mirrors what Mantis actually prints: the banner and swarm
event lines from src/cli.js, the `> tool param=value` tool-call render from
formatToolCall in src/utils.js, and the `  cwd > ` prompt from cli.js:153. If
the REPL's output changes, change it here too — a demo that flatters the tool
is worse than no demo, because someone installs it expecting what they saw.
"""
import os

from termshot import Term, FG, GREEN, DIM, CYAN, YELLOW

# colors.user is chalk.blue.bold; termshot's palette has no blue.
BLUE = (110, 162, 232)
# colors.toolParam is chalk.gray, a step darker than DIM.
GRAY = (150, 156, 168)
# phaseLabel is chalk.magenta.bold.
MAGENTA = (198, 138, 220)

# DejaVu where it exists (Linux, termshot's default), Consolas on Windows.
# Both carry the braille spinner and check glyphs the swarm demo needs.
FONTS = {}
if not os.path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
    win = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    if os.path.exists(os.path.join(win, "consola.ttf")):
        FONTS = {"reg": os.path.join(win, "consola.ttf"),
                 "bold": os.path.join(win, "consolab.ttf")}

PROMPT = [("  shop-api > ", BLUE, True)]
HERE = os.path.dirname(os.path.abspath(__file__))


# ── shared line builders ────────────────────────────────────────────────────

def tool(name, params, provider=None):
    """`  [groq] > edit_file path=src/auth.js` — formatToolCall's exact shape,
    with the swarm's dim [provider] prefix when there is one."""
    segs = [("  ", FG, False)]
    if provider:
        segs.append((f"[{provider}] ", DIM, False))
    segs += [("> ", CYAN, True), (name, CYAN, True)]
    for k, v in params:
        segs += [(f" {k}", GRAY, False), ("=", GRAY, False), (v, FG, False)]
    return segs


def result(text):
    return [("    " + text, DIM, False)]


def blink_at_prompt(t, times=3, ms=500, hold_ms=1800):
    """t.blink() blinks at the shell prompt, but the session hasn't exited."""
    base = list(t._screen)
    for _ in range(times):
        t.add(base + [PROMPT + [("█", FG, False)]], ms)
        t.add(base + [PROMPT], ms)
    t.add(base + [PROMPT + [("█", FG, False)]], hold_ms)
    return t


def type_at_prompt(t, command, step=3, char_ms=42):
    """termshot's t.type() animates at its own shell prompt; the REPL has its
    own. Same idea, our prompt segments."""
    base = list(t._screen)
    for n in range(1, len(command) + 1, step):
        t.add(base + [PROMPT + [(command[:n], FG, False), ("█", FG, False)]], char_ms)
    t.add(base + [PROMPT + [(command, FG, False), ("█", FG, False)]], 500)
    t.add(base + [PROMPT + [(command, FG, False)]], 180)
    t._screen.append(PROMPT + [(command, FG, False)])
    return t


# ── demo 1: one task, start to finish ───────────────────────────────────────

def build_task():
    t = Term(title="mantis — agentic coding CLI", user="me@box", cwd="~/shop-api",
             rows=29, **FONTS)

    t.type("mantis").blank(200)

    # The banner, as src/cli.js prints it.
    t.reveal([
        [("     \\_/", GREEN, False)],
        [("    (o.o)", GREEN, False), ("    MANTIS", GREEN, True)],
        [("   _/|\\_", GREEN, False), ("    Agentic coding assistant", DIM, False)],
        [("  / / \\ \\", GREEN, False)],
        [("    / \\", GREEN, False), ("      Working directory: ~/shop-api", DIM, False)],
        [("   /   \\", GREEN, False), ("     Model: qwen3-coder via http://localhost:11434", DIM, False)],
        [("             Context limit: 32,768 tokens", DIM, False)],
    ], 90)
    t.out([("  Type /help for commands, /exit to quit", DIM, False)], 420).blank(300)

    type_at_prompt(t, "the /login redirect loops on expired sessions — fix it and add a test")
    t.blank(200)

    t.out(tool("search_files", [("pattern", "redirect"), ("path", "src")]), 520)
    t.out(result("3 matches in src/auth.js, src/routes/login.js"), 700)

    t.out(tool("read_file", [("path", "src/auth.js")]), 520)
    t.out(result("142 lines"), 650)

    t.out([("  The session check redirects before clearing the expired cookie, so", FG, False)], 520)
    t.out([("  /login bounces straight back. Clearing it first breaks the loop.", FG, False)], 700)

    t.out(tool("edit_file", [("path", "src/auth.js")]), 520)
    t.out(result("1 replacement"), 620)

    t.out(tool("write_file", [("path", "test/auth.expired.test.js")]), 520)
    t.out(result("38 lines written"), 620)

    t.out(tool("run_command", [("command", "npm test -- auth")]), 520)
    t.out(result("PASS  test/auth.expired.test.js  (4 passing)"), 800)

    t.blank(150)
    t.out([("  Fixed and covered. ", GREEN, True),
           ("2 files changed · /undo to roll back", DIM, False)], 900)
    blink_at_prompt(t)
    return t


# ── demo 2: swarm mode ──────────────────────────────────────────────────────

# ora's non-unicode fallback set: the `line` spinner and log-symbols' √. Not
# an arbitrary choice — neither DejaVu Sans Mono nor Consolas carries the
# braille dots or ✔ that ora uses on a unicode terminal, and a missing glyph
# renders as a tofu box, not as nothing. This is what a Windows terminal shows.
# Check coverage by rendering the char and diffing it against a private-use
# codepoint; PIL's getbbox() returns a box for .notdef too, so it proves nothing.
SPIN = "-\\|/"
TICK = "√"

# cli.js runs a single spinner and rewrites its text per worker, so the workers
# read sequentially here — same as the real CLI, even though they are running
# in parallel underneath.


def phase(name, provider=None):
    segs = [(f"  [{name}]", MAGENTA, True)]
    if provider:
        segs.append((f" {provider}", DIM, False))
    return segs


def worker(t, provider, text, cycles=16, ms=90):
    """Spin on one line, then commit ora's green succeed line over it."""
    base = list(t._screen)
    for i in range(cycles):
        t.add(base + [[("  " + SPIN[i % len(SPIN)] + " ", CYAN, False),
                       (f"[{provider}] {text}", DIM, False)]], ms)
    t._screen.append([(f"  {TICK} ", GREEN, False), (f"[{provider}] {text} done", DIM, False)])
    t.add(list(t._screen), 260)
    return t


def build_swarm():
    # Starts inside the REPL — the banner is demo 1's job, and the rows are
    # better spent on the swarm itself.
    t = Term(title="mantis — swarm mode", user="me@box", cwd="~/shop-api",
             rows=26, **FONTS)
    t._screen.append(None)

    type_at_prompt(t, "/swarm refactor the auth module and cover it with tests")
    t.blank(250)

    t.out([("  SWARM MODE", YELLOW, False)], 600)
    t.out([("  Pool: groq, cerebras, gemini, ollama, openai", DIM, False)], 420)
    t.out([("  Lead: groq | 5 providers | complexity: hard", DIM, False)], 700)
    t.blank(200)

    t.out(phase("PLAN", "groq"), 900)
    t.out([("  → 3 explore, 2 code, 1 review tasks", DIM, False)], 800)
    t.blank(200)

    t.out(phase("EXPLORE"), 500)
    worker(t, "cerebras", "map session + cookie handling")
    worker(t, "ollama", "find every redirect call site")
    worker(t, "gemini", "check existing auth test coverage")
    t.blank(200)

    t.out(phase("CODE", "groq"), 700)
    t.out(tool("edit_file", [("path", "src/auth.js")], provider="groq"), 520)
    t.out(result("1 replacement"), 600)
    t.out(tool("write_file", [("path", "test/auth.expired.test.js")], provider="groq"), 520)
    t.out(result("38 lines written"), 700)
    t.blank(200)

    t.out(phase("REVIEW", "cerebras"), 700)
    t.out([("  [cerebras] Review: correct — also assert the cookie is cleared", DIM, False)], 900)
    t.blank(150)
    t.out([("  Swarm complete. 5 providers, 41.8s", GREEN, True)], 900)
    blink_at_prompt(t)
    return t


for _name, _build in [("mantis-demo", build_task), ("mantis-swarm", build_swarm)]:
    _t = _build()
    _out = os.path.join(HERE, _name)
    print("wrote", _t.save_gif(_out + ".gif"))
    print("wrote", _t.save_png(_out + ".png"))

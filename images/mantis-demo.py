#!/usr/bin/env python3
"""Regenerate images/mantis-demo.gif — the README demo.

    pip install pillow
    git clone https://github.com/sp00nznet/termshot
    PYTHONPATH=../termshot python3 images/mantis-demo.py

Every line here mirrors what Mantis actually prints: the banner from
src/cli.js, the `> tool param=value` tool-call render from formatToolCall in
src/utils.js, and the `  cwd > ` prompt from cli.js:153. If the REPL's output
changes, change it here too — a demo that flatters the tool is worse than no
demo, because someone installs it expecting what they saw.
"""
import os

from termshot import Term, FG, GREEN, DIM, CYAN

# colors.user is chalk.blue.bold; termshot's palette has no blue.
BLUE = (110, 162, 232)
# colors.toolParam is chalk.gray, a step darker than DIM.
GRAY = (150, 156, 168)

# DejaVu where it exists (Linux, termshot's default), Consolas on Windows.
FONTS = {}
if not os.path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
    win = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    if os.path.exists(os.path.join(win, "consola.ttf")):
        FONTS = {"reg": os.path.join(win, "consola.ttf"),
                 "bold": os.path.join(win, "consolab.ttf")}

PROMPT = [("  shop-api > ", BLUE, True)]
TASK = "the /login redirect loops on expired sessions — fix it and add a test"


def tool(name, params):
    """`  > read_file path=src/auth.js` — formatToolCall's exact shape."""
    segs = [("  > ", CYAN, True), (name, CYAN, True)]
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

type_at_prompt(t, TASK)
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

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mantis-demo")
print("wrote", t.save_gif(out + ".gif"))
print("wrote", t.save_png(out + ".png"))

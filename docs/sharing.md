# Session Sharing

Share a live Mantis session with someone else through a link. They open it in a
browser and **watch** the session in real time — or **join** it and send the
agent input themselves.

It builds on the same session hub as the [admin panel](proxy.md#sessions-tab):
the link opens a focused single-session page, no Mantis account required — the
link itself is the credential.

---

## Creating a link

In the REPL:

```
/share          # watch-only link  (the guest can see, not control)
/share join     # join link        (the guest can also send input)
/share list     # show active links
/share stop     # revoke all links
```

```
  Share link — watch only:
  http://192.168.1.20:8788/s/3f9a1c7e08b2d4
  Local:  http://127.0.0.1:8788/s/3f9a1c7e08b2d4
```

`/share` starts the admin server (bound to all interfaces so other devices can
reach it) and registers your REPL session, then mints the link. Send the link
to whoever you want in the session.

Links expire after 24 hours; `/share stop` revokes them immediately.

---

## Watch vs. join

| Mode | The guest can… |
|------|----------------|
| **watch** (default) | see the session's live output |
| **join** | see output **and** send messages to the agent |

> **Join mode is powerful.** A guest with a join link drives an agent that has
> full tool access — it can read, write, and run commands on **your** machine.
> Only send join links to people you trust, and use `/share stop` when done.

---

## Reaching the link

- **Same network** — the `http://<lan-ip>:8788/s/…` link works directly for
  anyone on your LAN.
- **Over the internet** — browsers can't reach a private LAN address. Put a
  tunnel in front (Cloudflare Tunnel, ngrok, tailscale) pointed at port `8788`,
  and share the tunnel's URL with `/s/<token>` appended.

The share routes (`/s/…`) are the only thing exposed without a login — the
admin panel itself stays restricted, so opening the port for sharing doesn't
expose your keys or settings.

---

## Notes

- The guest page is a real terminal (xterm.js) with the session's scrollback.
- Multiple guests can hold links to the same session at once.
- Sharing the REPL session means guests see — and in join mode, drive — the
  exact session you're working in. To share a separate sandbox instead, create
  a fresh session in the admin panel's Sessions tab and share that.

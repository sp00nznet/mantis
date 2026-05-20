# Sign-in & Multi-user

Mantis can require a **sign-in** for the admin panel and the desktop app. Once
enabled, every account gets its own isolated workspace — conversation history,
projects, git connections, API keys, provider, model, and theme are all
namespaced per account.

Accounts are **built-in local username/password** users — no external service
needed. **Google sign-in** is an optional add-on you can layer on afterwards.

This is **opt-in and dormant by default**. Until you enable it, Mantis behaves
exactly as before: single-user, no sign-in, admin panel restricted to localhost.

---

## What changes when it's on

| | Sign-in **off** (default) | Sign-in **on** |
|---|---|---|
| Admin panel access | localhost only | any network address, login required |
| Desktop app | opens straight to the workspace | login screen first |
| Data location | `~/.mantis/` | `~/.mantis/users/<id>/` per account |
| API keys, provider, model, theme | shared, global | per account |
| Conversation history & projects | shared | per account |

Server-wide settings (proxy routing, bot tokens, context window, swarm pool)
stay global and are **admin-only**.

### Roles

- **Admin** — manages user accounts and server-global settings (proxy, bots,
  general/swarm settings), plus everything a user can do.
- **User** — their own sessions, provider keys, model, and theme. They don't see
  the Proxy, Bots, or Users tabs.

---

## Turning it on

### Option A — from the admin panel (recommended)

1. Run `mantis admin` and open `http://127.0.0.1:8788/admin`.
2. Go to the **Users** tab → **Enable sign-in**.
3. Pick an administrator username and password → **Enable sign-in**.

The panel reloads and now requires a login. It also starts listening on the
network so other devices can reach it.

### Option B — from the command line

```bash
mantis auth admin <username> <password>
```

Creates the admin account (or resets an existing one) and enables sign-in.
Other CLI commands:

```bash
mantis auth list       # list accounts
mantis auth disable    # turn sign-in back off (single-user, localhost-only)
mantis auth            # show current status
```

`mantis auth` is also your **recovery path** — if you're ever locked out, run
`mantis auth admin <username> <newpassword>` on the machine to reset access, or
`mantis auth disable` to switch sign-in off entirely. Accounts are kept either
way.

---

## Managing users

In the admin panel's **Users** tab (admins only) you can:

- **Add a user** — give a password for local login, an email for Google
  sign-in, or both. Pick the **user** or **admin** role.
- **Reset a password**, **change a role**, or **delete** an account.

The last administrator can't be demoted or deleted, so you can't lock yourself
out from the UI.

---

## Google sign-in (optional add-on)

Local accounts work on their own. To also offer "Sign in with Google":

### 1. Create a Google OAuth client

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs &
   Services → Credentials → Create credentials → OAuth client ID → Web
   application**.
2. Under **Authorized redirect URIs**, add the ones you'll use:
   - `http://localhost:8788/auth/callback` — standalone admin panel
   - `http://localhost:8787/auth/callback` — admin panel mounted on `mantis serve`
   - `http://localhost:8790` — the desktop app
   - For phone access, add your machine's HTTPS URL (see *Phone access*).
3. Copy the **Client ID** and **Client secret**.

### 2. Add the credentials to `~/.mantis/config.json`

```json
{
  "google": { "clientId": "...apps.googleusercontent.com", "clientSecret": "..." }
}
```

A "Sign in with Google" button now appears on the login screens.

### 3. Decide who may sign in with Google

In the **Users → Google sign-in** card:

- **Pre-create the account** — add a user with their email; when they sign in
  with Google it links to that account. (Most controlled — the default.)
- **Domain allowlist** — list email domains (e.g. `mycompany.com`); anyone with
  a Google account on those domains is auto-provisioned as a user. This is the
  G Suite / Workspace path.
- **Open signup** — let any Google account sign in and self-provision.

An unknown Google account with none of these is rejected.

### Phone access

Google only redirects OAuth to `localhost` or an **HTTPS** URL — never a bare
`http://192.168.x.x` LAN address. To reach the panel from a phone you need
HTTPS in front of it: a reverse proxy (Caddy, nginx, Cloudflare Tunnel, ngrok)
that terminates TLS and forwards to the admin port. Add that HTTPS URL's
`/auth/callback` to the authorized redirect URIs.

---

## Admin panel

With sign-in on, `mantis admin` binds to `0.0.0.0` so other devices on the
network can reach it. Every request needs a valid session cookie
(`mantis_session`, HttpOnly, 30-day expiry, stored in
`~/.mantis/auth-sessions.json`). The login screen offers username/password and,
if configured, Google. The panel is **mobile-responsive** — on a phone the icon
rail becomes a bottom tab bar.

> With sign-in **off**, the admin panel keeps its localhost-only restriction —
> a non-loopback request gets a `403`. Sign-in is what makes network access safe.

## Desktop app

With sign-in on, the desktop app shows a login screen on launch
(username/password, plus Google if configured). The Google flow runs a loopback
listener on port `8790`. The login persists across restarts; sign out from the
avatar chip at the bottom of the icon rail.

---

## Data layout

```
~/.mantis/
├── config.json            # global — providers pool, proxy, bots, auth, google
├── accounts.json           # the account database (scrypt password hashes)
├── auth-sessions.json      # active session cookies
└── users/
    └── u1a2b3c.../         # one folder per account (its id)
        ├── prefs.json      # provider, model, API keys, theme
        ├── sessions/       # conversation history
        ├── projects.json   # desktop project registry
        └── git.json        # desktop git connections (tokens encrypted)
```

When sign-in is off there is no `users/` folder — data stays at the top-level
legacy paths, so existing single-user installs are untouched.

---

## Security notes

- Passwords are stored as salted **scrypt** hashes — no plaintext, no
  reversible encoding.
- Session cookies are `HttpOnly` and `SameSite=Lax`.
- The Google `id_token` is received directly from Google's token endpoint over
  TLS, so its claims are trusted without re-verifying the JWT signature.
- API keys are stored per account; desktop git tokens are encrypted with the OS
  keystore (Electron `safeStorage`) when available.
- Enabling sign-in is the **only** way to safely expose the admin panel beyond
  localhost — without it, anyone on the network could spend your provider quota.

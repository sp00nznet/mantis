/**
 * Discord bot wrapper — drive Mantis from a Discord server or DM.
 *
 * Connects to the Discord gateway over WebSocket (no extra dependencies —
 * uses Node's built-in global WebSocket, Node 22+). Mention the bot in a
 * channel, or DM it directly. Each channel keeps its own agent session.
 *
 * Start with:  mantis bot discord
 *
 * The bot needs the MESSAGE CONTENT privileged intent enabled in the
 * Discord Developer Portal.
 */

import { getConfig } from '../config.js';
import { createBotSession, runBotCommand, formatResult, chunkMessage } from '../bot-core.js';

const DISCORD_LIMIT = 2000;
const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export async function startDiscordBot() {
  const config = getConfig();
  const token = config.bots?.discord?.token;
  if (!token) {
    console.error('  No Discord token configured.');
    console.error('  Set one in the admin UI (mantis admin) or with /bot in the REPL.');
    throw new Error('No Discord token configured');
  }
  if (typeof WebSocket === 'undefined') {
    console.error('  This Node build has no global WebSocket — the Discord bot needs Node 22+.');
    throw new Error('Global WebSocket unavailable — Node 22+ required');
  }
  const allowed = (config.bots?.discord?.allowedUsers || []).map(String);

  // ─── REST helpers ─────────────────────────────────────────────────
  const authHeaders = { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' };

  async function rest(method, path, body) {
    return fetch(`${API}${path}`, {
      method,
      headers: authHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function send(channelId, text) {
    for (const chunk of chunkMessage(text, DISCORD_LIMIT)) {
      try { await rest('POST', `/channels/${channelId}/messages`, { content: chunk }); }
      catch { /* ignore individual send failures */ }
    }
  }
  const typing = (channelId) => rest('POST', `/channels/${channelId}/typing`).catch(() => {});

  // ─── Sessions ─────────────────────────────────────────────────────
  const sessions = new Map(); // channelId -> session
  function sessionFor(channelId) {
    if (!sessions.has(channelId)) sessions.set(channelId, createBotSession());
    return sessions.get(channelId);
  }

  let botUserId = null;

  async function handleMessageCreate(d) {
    if (!d || d.author?.bot) return;

    const isDM = !d.guild_id;
    const mentioned = Array.isArray(d.mentions) && d.mentions.some(m => m.id === botUserId);
    if (!isDM && !mentioned) return; // only respond when addressed

    let content = (d.content || '')
      .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
      .trim();
    if (!content) return;

    if (allowed.length && !allowed.includes(String(d.author?.id))) {
      await send(d.channel_id, '⛔ You are not on this bot\'s allowed list.');
      return;
    }

    const session = sessionFor(d.channel_id);

    if (content.startsWith('/')) {
      await send(d.channel_id, await runBotCommand(content, session));
      return;
    }

    await typing(d.channel_id);
    const result = await session.run(content);
    await send(d.channel_id, formatResult(result));
  }

  // ─── Gateway connection ───────────────────────────────────────────
  function connect() {
    const ws = new WebSocket(GATEWAY);
    let heartbeatTimer = null;
    let firstBeatTimer = null;
    let seq = null;
    let acked = true;

    const clearTimers = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (firstBeatTimer) clearTimeout(firstBeatTimer);
      heartbeatTimer = firstBeatTimer = null;
    };
    const beat = () => {
      if (!acked) { try { ws.close(4000); } catch {} return; } // zombie — force reconnect
      acked = false;
      try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch {}
    };

    ws.addEventListener('open', () => {
      console.log('  [discord] gateway connected');
    });

    ws.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      const { op, d, s, t } = payload;
      if (s != null) seq = s;

      if (op === 10) {
        // HELLO — begin heartbeating, then identify.
        const interval = d.heartbeat_interval;
        firstBeatTimer = setTimeout(() => {
          beat();
          heartbeatTimer = setInterval(beat, interval);
        }, interval * Math.random());
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token,
            intents: INTENTS,
            properties: { os: process.platform, browser: 'mantis', device: 'mantis' },
          },
        }));
      } else if (op === 1) {
        beat(); // gateway asked for an immediate heartbeat
      } else if (op === 11) {
        acked = true;
      } else if (op === 7 || op === 9) {
        try { ws.close(4000); } catch {} // reconnect / invalid session
      } else if (op === 0) {
        if (t === 'READY') {
          botUserId = d.user?.id;
          console.log(`  [discord] ready as ${d.user?.username} (mention me or DM me)`);
          if (allowed.length) console.log(`  [discord] restricted to ${allowed.length} allowed user id(s)`);
        } else if (t === 'MESSAGE_CREATE') {
          handleMessageCreate(d).catch(err => console.error('  [discord]', err.message));
        }
      }
    });

    ws.addEventListener('error', () => { /* surfaced by the close event */ });

    ws.addEventListener('close', (event) => {
      clearTimers();
      console.error(`  [discord] gateway closed (${event.code}) — reconnecting in 5s`);
      setTimeout(connect, 5000);
    });
  }

  console.log('  [discord] connecting to gateway — Ctrl+C to stop');
  connect();
}

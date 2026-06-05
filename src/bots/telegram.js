/**
 * Telegram bot wrapper — drive Mantis from a Telegram chat.
 *
 * Uses long-polling (getUpdates), so it needs no public URL or webhook —
 * just a bot token from @BotFather. Each chat keeps its own agent session.
 *
 * Start with:  mantis bot telegram
 */

import { getConfig } from '../config.js';
import { runBotCommand, formatResult, chunkMessage } from '../bot-core.js';
import { gatewaySession } from '../gateway.js';
import { transcribeAudio } from '../transcribe.js';

const TG_LIMIT = 4096;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function startTelegramBot() {
  const config = getConfig();
  const token = config.bots?.telegram?.token;
  if (!token) {
    console.error('  No Telegram token configured.');
    console.error('  Set one in the admin UI (mantis admin) or with /bot in the REPL.');
    throw new Error('No Telegram token configured');
  }
  const allowed = (config.bots?.telegram?.allowedUsers || []).map(String);
  const API = `https://api.telegram.org/bot${token}`;

  async function tg(method, params) {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return r.json();
  }

  async function send(chatId, text) {
    for (const chunk of chunkMessage(text, TG_LIMIT)) {
      try { await tg('sendMessage', { chat_id: chatId, text: chunk }); }
      catch { /* ignore individual send failures */ }
    }
  }

  // Verify the token up front.
  const me = await tg('getMe').catch(() => null);
  if (!me || !me.ok) {
    console.error('  Telegram rejected the bot token. Check it and try again.');
    throw new Error('Telegram rejected the bot token');
  }
  console.log(`  [telegram] connected as @${me.result.username}`);
  console.log(`  [telegram] polling for messages — Ctrl+C to stop`);
  if (allowed.length) console.log(`  [telegram] restricted to ${allowed.length} allowed user/chat id(s)`);

  // Persistent, gateway-owned sessions keyed by (platform, chatId). They survive
  // a bot restart and rehydrate on the next message.
  const sessionFor = (chatId) => gatewaySession('telegram', chatId);

  /** Download a Telegram file by id. Returns { buffer } or { error }. */
  async function downloadTgFile(fileId) {
    const info = await tg('getFile', { file_id: fileId }).catch(() => null);
    const filePath = info?.result?.file_path;
    if (!filePath) return { error: 'Could not locate that file on Telegram.' };
    try {
      const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) return { error: `Telegram file download failed (HTTP ${r.status}).` };
      return { buffer: Buffer.from(await r.arrayBuffer()) };
    } catch (err) {
      return { error: 'Voice download failed: ' + err.message };
    }
  }

  async function handleMessage(msg) {
    const chatId = msg.chat?.id;
    if (!chatId) return;

    const fromId = String(msg.from?.id ?? '');
    if (allowed.length && !allowed.includes(fromId) && !allowed.includes(String(chatId))) {
      await send(chatId, '⛔ You are not on this bot\'s allowed list.');
      return;
    }

    let text = (msg.text || '').trim();

    // A voice note or audio message — transcribe it to text first.
    const voice = msg.voice;
    const audio = msg.audio;
    if (!text && (voice || audio)) {
      await send(chatId, '🎙️ Transcribing your voice note…');
      const dl = await downloadTgFile((voice || audio).file_id);
      if (dl.error) { await send(chatId, '⚠️ ' + dl.error); return; }
      const name = voice ? 'voice.ogg' : (audio.file_name || 'audio.mp3');
      const tr = await transcribeAudio(dl.buffer, name);
      if (tr.error) { await send(chatId, '⚠️ ' + tr.error); return; }
      text = tr.text;
      await send(chatId, '📝 ' + text);
    }
    if (!text) return;

    const session = sessionFor(chatId);

    if (text.startsWith('/')) {
      await send(chatId, await runBotCommand(text, session));
      return;
    }

    await send(chatId, '🐜 Working…');
    const result = await session.run(text);
    await send(chatId, formatResult(result));
  }

  // ─── Long-poll loop ───────────────────────────────────────────────
  let offset = 0;
  while (true) {
    let updates;
    try {
      const r = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, {
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json();
      updates = j.ok ? j.result : [];
    } catch {
      await sleep(2000); // network hiccup — back off and retry
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message || u.edited_message;
      if (msg) handleMessage(msg).catch(err => console.error('  [telegram]', err.message));
    }
  }
}

/**
 * Voice-note transcription for the chat bots.
 *
 * Sends audio to an OpenAI-compatible /audio/transcriptions endpoint — Groq's
 * fast Whisper by default, or OpenAI. No dependencies: the multipart upload is
 * built with the global FormData/Blob/fetch.
 */

import { getConfig, PROVIDERS } from './config.js';

const MAX_BYTES = 25 * 1024 * 1024; // Whisper API upload cap

// Default Whisper model per provider when config.transcription.model is blank.
const DEFAULT_MODEL = {
  groq: 'whisper-large-v3-turbo',
  openai: 'whisper-1',
};

function settings() {
  const t = getConfig().transcription || {};
  return {
    enabled: t.enabled !== false,
    provider: t.provider || 'groq',
    model: t.model || '',
  };
}

/**
 * Whether voice transcription is configured and ready to use.
 * @returns {{ready:boolean, reason?:string}}
 */
export function transcriptionReady() {
  const s = settings();
  if (!s.enabled) return { ready: false, reason: 'Voice transcription is turned off.' };
  const provider = PROVIDERS[s.provider];
  if (!provider) return { ready: false, reason: `Unknown transcription provider: ${s.provider}` };
  const apiKey = (getConfig().providerKeys || {})[s.provider];
  if (provider.requiresKey && !apiKey) {
    return { ready: false, reason: `No ${provider.name} API key — add one to enable voice transcription.` };
  }
  return { ready: true };
}

/**
 * Transcribe an audio buffer to text.
 * @param {Buffer} audioBuffer - the raw audio bytes
 * @param {string} [filename] - a name with an extension Whisper recognises
 * @returns {Promise<{text:string}|{error:string}>}
 */
export async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
  const ready = transcriptionReady();
  if (!ready.ready) return { error: ready.reason };
  if (!audioBuffer || !audioBuffer.length) return { error: 'The voice note was empty.' };
  if (audioBuffer.length > MAX_BYTES) {
    return { error: 'That voice note is too large to transcribe (over 25 MB).' };
  }

  const s = settings();
  const provider = PROVIDERS[s.provider];
  const apiKey = (getConfig().providerKeys || {})[s.provider];
  const model = s.model || DEFAULT_MODEL[s.provider] || 'whisper-large-v3';
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', model);
  form.append('response_format', 'json');

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json())?.error?.message || ''; } catch { /* ignore */ }
      return { error: `Transcription failed (HTTP ${r.status})${detail ? ': ' + detail : ''}` };
    }
    const data = await r.json();
    const text = (data.text || '').trim();
    return text ? { text } : { error: 'The transcription came back empty.' };
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'transcription timed out' : err.message;
    return { error: `Transcription error: ${msg}` };
  }
}

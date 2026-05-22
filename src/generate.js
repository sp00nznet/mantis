/**
 * Media generation tools — turn text into image or audio files.
 *
 *  generate_image  — text → image via an OpenAI-compatible /images/generations endpoint.
 *  generate_speech — text → audio via an OpenAI-compatible /audio/speech endpoint.
 *
 * Both save to the working directory and need an API key for the configured
 * provider (config.imageGen / config.speech).
 */

import fs from 'fs';
import path from 'path';
import { getConfig, PROVIDERS } from './config.js';
import { recordChange } from './checkpoints.js';

function providerBase(providerKey) {
  const p = PROVIDERS[providerKey];
  return p ? p.baseUrl.replace(/\/+$/, '') : null;
}

function save(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  recordChange(dest);          // so /undo can delete a generated file
  fs.writeFileSync(dest, bytes);
}

/** Generate an image from a prompt and save it to disk. */
export async function generateImage(prompt, outPath, size, workingDir) {
  if (!prompt || !prompt.trim()) return 'Error: generate_image needs a prompt.';
  const cfg = getConfig();
  const g = cfg.imageGen || {};
  const providerKey = g.provider || 'openai';
  const base = providerBase(providerKey);
  if (!base) return `Error: unknown image provider "${providerKey}".`;
  const apiKey = (cfg.providerKeys || {})[providerKey];
  if (!apiKey) return `Error: no API key for ${providerKey} — set one to generate images.`;

  const model = g.model || 'gpt-image-1';
  const dest = path.isAbsolute(outPath) ? outPath : path.join(workingDir, outPath);
  const body = { model, prompt, n: 1, size: size || '1024x1024' };

  let r;
  try {
    r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return `Image generation request failed: ${err.message}`;
  }
  if (!r.ok) {
    let detail = ''; try { detail = (await r.json())?.error?.message || ''; } catch { /* ignore */ }
    return `Image generation failed (HTTP ${r.status})${detail ? ': ' + detail : ''}`;
  }

  let data;
  try { data = await r.json(); } catch { return 'Image generation returned an invalid response.'; }
  const item = data.data?.[0];
  if (!item) return 'Image generation returned no image.';

  let bytes;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    try {
      const ir = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
      bytes = Buffer.from(await ir.arrayBuffer());
    } catch (err) {
      return `Could not download the generated image: ${err.message}`;
    }
  } else {
    return 'Image generation returned no usable image data.';
  }

  try { save(dest, bytes); }
  catch (err) { return `Could not save the image: ${err.message}`; }
  return `Image generated and saved to ${dest} (${(bytes.length / 1024).toFixed(0)} KB, ${body.size}).`;
}

/** Generate spoken audio from text (text-to-speech) and save it to disk. */
export async function generateSpeech(text, outPath, voice, workingDir) {
  if (!text || !text.trim()) return 'Error: generate_speech needs text.';
  const cfg = getConfig();
  const s = cfg.speech || {};
  const providerKey = s.provider || 'openai';
  const base = providerBase(providerKey);
  if (!base) return `Error: unknown speech provider "${providerKey}".`;
  const apiKey = (cfg.providerKeys || {})[providerKey];
  if (!apiKey) return `Error: no API key for ${providerKey} — set one to generate speech.`;

  const model = s.model || 'gpt-4o-mini-tts';
  const dest = path.isAbsolute(outPath) ? outPath : path.join(workingDir, outPath);
  const body = { model, input: text, voice: voice || s.voice || 'alloy' };

  let r;
  try {
    r = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return `Speech generation request failed: ${err.message}`;
  }
  if (!r.ok) {
    let detail = ''; try { detail = await r.text(); } catch { /* ignore */ }
    return `Speech generation failed (HTTP ${r.status})${detail ? ': ' + detail.slice(0, 200) : ''}`;
  }

  let bytes;
  try { bytes = Buffer.from(await r.arrayBuffer()); }
  catch (err) { return `Could not read the generated audio: ${err.message}`; }

  try { save(dest, bytes); }
  catch (err) { return `Could not save the audio: ${err.message}`; }
  return `Speech generated and saved to ${dest} (${(bytes.length / 1024).toFixed(0)} KB).`;
}

/**
 * Media generation tools — turn text into image or audio files.
 *
 *  generate_image  — text → image. Supports three backends:
 *    • OpenAI-compat /v1/images/generations  (openai, together, fireworks,
 *      or any local shim — set imageGen.baseUrl)
 *    • NVIDIA NIM    /v1/genai/<model>       (provider: 'nvidia', uses the
 *      hosted ai.api.nvidia.com — same free key as chat models)
 *    • Automatic1111 /sdapi/v1/txt2img       (provider: 'a1111' with baseUrl,
 *      no key needed — local Stable Diffusion WebUI)
 *
 *  generate_speech — text → audio via OpenAI-compatible /audio/speech.
 */

import fs from 'fs';
import path from 'path';
import { getConfig, PROVIDERS } from './config.js';
import { recordChange } from './checkpoints.js';

const NVIDIA_GENAI_BASE = 'https://ai.api.nvidia.com/v1/genai';

function providerBase(providerKey) {
  const p = PROVIDERS[providerKey];
  return p ? p.baseUrl.replace(/\/+$/, '') : null;
}

function isLoopback(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url || '');
}

function parseSize(size, fallback = '1024x1024') {
  const [w, h] = String(size || fallback).split('x').map(n => parseInt(n, 10));
  return { width: w || 1024, height: h || 1024 };
}

function save(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  recordChange(dest);          // so /undo can delete a generated file
  fs.writeFileSync(dest, bytes);
}

function decodeBase64Image(b64) {
  return Buffer.from(String(b64).replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
}

// ─── NVIDIA NIM image gen ──────────────────────────────────────────
// Uses the hosted genai endpoint at ai.api.nvidia.com (not the chat
// host). Same free API key from build.nvidia.com works.
async function generateNvidia(prompt, dest, size, apiKey, g) {
  const model = g.model || 'black-forest-labs/flux.1-schnell';
  const { width, height } = parseSize(size || g.size);
  const body = {
    prompt,
    width,
    height,
    seed: g.seed ?? Math.floor(Math.random() * 1e9),
    steps: g.steps ?? 4,
    cfg_scale: g.cfg_scale ?? 0,
  };

  let r;
  try {
    r = await fetch(`${NVIDIA_GENAI_BASE}/${model}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    return `Image generation request failed: ${err.message}`;
  }
  if (!r.ok) {
    let detail = ''; try { detail = await r.text(); } catch { /* ignore */ }
    return `NVIDIA image generation failed (HTTP ${r.status})${detail ? ': ' + detail.slice(0, 300) : ''}`;
  }

  let data;
  try { data = await r.json(); } catch { return 'NVIDIA returned an invalid response.'; }
  const b64 = data.artifacts?.[0]?.base64 || data.image || data.images?.[0] || data.b64_json;
  if (!b64) return `NVIDIA returned no image data (keys: ${Object.keys(data).join(',')}).`;

  const bytes = decodeBase64Image(b64);
  try { save(dest, bytes); }
  catch (err) { return `Could not save the image: ${err.message}`; }
  return `Image generated and saved to ${dest} (${(bytes.length / 1024).toFixed(0)} KB, ${width}x${height}, NVIDIA ${model}).`;
}

// ─── Automatic1111 (local Stable Diffusion WebUI) ──────────────────
async function generateA1111(prompt, dest, size, baseUrl, g) {
  if (!baseUrl) return 'Error: a1111 backend needs imageGen.baseUrl (e.g. http://127.0.0.1:7860).';
  const { width, height } = parseSize(size || g.size);
  const body = {
    prompt,
    negative_prompt: g.negative_prompt || '',
    width,
    height,
    steps: g.steps ?? 20,
    cfg_scale: g.cfg_scale ?? 7,
    sampler_name: g.sampler || 'Euler a',
    ...(g.model ? { override_settings: { sd_model_checkpoint: g.model } } : {}),
  };

  let r;
  try {
    r = await fetch(`${baseUrl.replace(/\/+$/, '')}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),    // local SD can be slow on CPU
    });
  } catch (err) {
    return `Image generation request failed: ${err.message}`;
  }
  if (!r.ok) {
    let detail = ''; try { detail = await r.text(); } catch { /* ignore */ }
    return `A1111 image generation failed (HTTP ${r.status})${detail ? ': ' + detail.slice(0, 300) : ''}`;
  }

  let data;
  try { data = await r.json(); } catch { return 'A1111 returned an invalid response.'; }
  const b64 = data.images?.[0];
  if (!b64) return 'A1111 returned no image data.';

  const bytes = decodeBase64Image(b64);
  try { save(dest, bytes); }
  catch (err) { return `Could not save the image: ${err.message}`; }
  return `Image generated and saved to ${dest} (${(bytes.length / 1024).toFixed(0)} KB, ${width}x${height}, local SD).`;
}

// ─── OpenAI-compatible /v1/images/generations ──────────────────────
// Works for openai, together, fireworks, or any local shim (ComfyUI's
// OpenAI-compat extension, sd-webui-openai-images-api, etc.).
async function generateOpenAICompat(prompt, dest, size, base, apiKey, providerKey, g) {
  const model = g.model || 'gpt-image-1';
  const body = { model, prompt, n: 1, size: size || g.size || '1024x1024' };

  let r;
  try {
    r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
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
    bytes = decodeBase64Image(item.b64_json);
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
  return `Image generated and saved to ${dest} (${(bytes.length / 1024).toFixed(0)} KB, ${body.size}, ${providerKey} ${model}).`;
}

/** Generate an image from a prompt and save it to disk. */
export async function generateImage(prompt, outPath, size, workingDir) {
  if (!prompt || !prompt.trim()) return 'Error: generate_image needs a prompt.';
  const cfg = getConfig();
  const g = cfg.imageGen || {};
  const providerKey = g.provider || 'openai';
  const dest = path.isAbsolute(outPath) ? outPath : path.join(workingDir, outPath);

  // Automatic1111 — local Stable Diffusion WebUI, no API key required.
  if (providerKey === 'a1111' || g.kind === 'a1111') {
    return generateA1111(prompt, dest, size, g.baseUrl, g);
  }

  // NVIDIA NIM — hosted, free key, custom genai endpoint.
  if (providerKey === 'nvidia') {
    const apiKey = (cfg.providerKeys || {})[providerKey] || g.apiKey;
    if (!apiKey) return 'Error: no API key for nvidia — set one to generate images.';
    return generateNvidia(prompt, dest, size, apiKey, g);
  }

  // OpenAI-compat — explicit baseUrl wins (lets users point at a local shim
  // without registering a provider). Otherwise look up the provider registry.
  const base = (g.baseUrl || providerBase(providerKey) || '').replace(/\/+$/, '');
  if (!base) return `Error: unknown image provider "${providerKey}".`;
  const apiKey = (cfg.providerKeys || {})[providerKey] || g.apiKey || '';
  if (!apiKey && !isLoopback(base)) {
    return `Error: no API key for ${providerKey} — set one to generate images.`;
  }
  return generateOpenAICompat(prompt, dest, size, base, apiKey, providerKey, g);
}

/** Generate spoken audio from text (text-to-speech) and save it to disk. */
export async function generateSpeech(text, outPath, voice, workingDir) {
  if (!text || !text.trim()) return 'Error: generate_speech needs text.';
  const cfg = getConfig();
  const s = cfg.speech || {};
  const providerKey = s.provider || 'openai';
  const base = (s.baseUrl || providerBase(providerKey) || '').replace(/\/+$/, '');
  if (!base) return `Error: unknown speech provider "${providerKey}".`;
  const apiKey = (cfg.providerKeys || {})[providerKey] || s.apiKey || '';
  if (!apiKey && !isLoopback(base)) {
    return `Error: no API key for ${providerKey} — set one to generate speech.`;
  }

  const model = s.model || 'gpt-4o-mini-tts';
  const dest = path.isAbsolute(outPath) ? outPath : path.join(workingDir, outPath);
  const body = { model, input: text, voice: voice || s.voice || 'alloy' };

  let r;
  try {
    r = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
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

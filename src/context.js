/**
 * Context window management — tracks token usage and compacts
 * conversation history when approaching the model's context limit.
 *
 * Similar to Claude Code's automatic context compression.
 */

import { getConfig } from './config.js';

// Rough token estimation: ~4 chars per token for English text
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg) {
  let tokens = 4; // message overhead
  if (typeof msg.content === 'string') {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    // Multi-part content (vision messages): text parts + a flat cost per image.
    for (const part of msg.content) {
      if (part?.type === 'text') tokens += estimateTokens(part.text);
      else if (part?.type === 'image_url') tokens += 1000;
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function?.name || '');
      tokens += estimateTokens(tc.function?.arguments || '');
    }
  }
  return tokens;
}

export function countContextTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/** Flatten a message's content to plain text (handles vision array content). */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ');
    const hasImg = content.some(p => p?.type === 'image_url');
    return text + (hasImg ? ' [image]' : '');
  }
  return '';
}

export function shouldCompact(messages) {
  const config = getConfig();
  const used = countContextTokens(messages);
  return used >= config.maxContextTokens * config.compactThreshold;
}

/**
 * Compact conversation history by summarizing older exchanges.
 * Keeps the system prompt, the compaction summary, and the most recent messages.
 */
export function compactMessages(messages) {
  if (messages.length <= 4) return messages; // nothing to compact

  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const start = systemMsg ? 1 : 0;

  // Keep the most recent turns (last ~30% of messages, minimum 6)
  const keepCount = Math.max(6, Math.floor(messages.length * 0.3));
  const cutoff = messages.length - keepCount;

  if (cutoff <= start) return messages; // not enough to compact

  // Build summary of older messages
  const older = messages.slice(start, cutoff);
  const summaryParts = [];

  for (const msg of older) {
    if (msg.role === 'user') {
      const preview = contentText(msg.content).slice(0, 150);
      summaryParts.push(`- User asked: ${preview}`);
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const tools = msg.tool_calls.map(tc => tc.function?.name).join(', ');
      summaryParts.push(`- Assistant used tools: ${tools}`);
    } else if (msg.role === 'assistant' && msg.content) {
      const preview = contentText(msg.content).slice(0, 150);
      summaryParts.push(`- Assistant responded: ${preview}`);
    }
    // Skip tool result messages in summary — too verbose
  }

  const summaryText = `[Context compacted — earlier conversation summarized]\n\nPrevious conversation summary (${older.length} messages compressed):\n${summaryParts.join('\n')}`;

  const compacted = [];
  if (systemMsg) compacted.push(systemMsg);
  compacted.push({ role: 'user', content: summaryText });
  compacted.push({ role: 'assistant', content: 'Understood. I have the context from our earlier conversation. How can I continue helping you?' });
  compacted.push(...messages.slice(cutoff));

  return compacted;
}

export function getContextStats(messages) {
  const config = getConfig();
  const used = countContextTokens(messages);
  const max = config.maxContextTokens;
  const pct = Math.round((used / max) * 100);
  return { used, max, pct };
}

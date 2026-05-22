/**
 * Web tools — let the agent read pages and search the web.
 *
 *  web_fetch  — download a URL and return readable text.
 *  web_search — query the web: via Perplexity 'sonar' when a Perplexity key is
 *               configured, otherwise a keyless DuckDuckGo HTML scrape.
 */

import { getConfig } from './config.js';

const UA = 'Mozilla/5.0 (compatible; MantisBot/1.0)';

/** Strip HTML down to rough plain text — no dependencies. */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCharCode(+n); } catch { return ''; } })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Download a URL and return its content.
 * @param {string} url
 * @param {boolean} [raw] - return the raw source (HTML/CSS/JS) instead of
 *   stripped text — needed for cloning a page's markup and styles.
 */
export async function webFetch(url, raw) {
  if (!/^https?:\/\//i.test(url || '')) {
    return 'Error: web_fetch needs an http(s) URL.';
  }
  let r;
  try {
    r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return `Error fetching ${url}: ${err.name === 'TimeoutError' ? 'request timed out' : err.message}`;
  }
  if (!r.ok) return `Error: ${url} returned HTTP ${r.status}`;

  const ctype = r.headers.get('content-type') || '';
  let body;
  try { body = await r.text(); }
  catch (err) { return `Error reading ${url}: ${err.message}`; }

  const text = raw ? body : (/html/i.test(ctype) ? htmlToText(body) : body.trim());
  const max = raw ? 50000 : 12000;
  const clipped = text.length > max
    ? text.slice(0, max) + `\n\n… (truncated — ${text.length} chars total)`
    : text;
  const label = raw ? `Raw source of ${url}` : `Content of ${url}`;
  return `${label}:\n\n${clipped}`;
}

/** Search the web for a query. */
export async function webSearch(query) {
  if (!query || !query.trim()) return 'Error: web_search needs a query.';
  const pplxKey = getConfig().providerKeys?.perplexity;
  if (pplxKey) {
    const viaPplx = await searchViaPerplexity(query, pplxKey);
    if (viaPplx) return viaPplx;
  }
  return searchViaDuckDuckGo(query);
}

async function searchViaPerplexity(query, key) {
  try {
    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'Answer concisely with current, factual information.' },
          { role: 'user', content: query },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null; // fall back to DuckDuckGo
    const data = await r.json();
    const answer = data.choices?.[0]?.message?.content || '';
    if (!answer) return null;
    const cites = Array.isArray(data.citations) ? data.citations : [];
    let out = `Web search for "${query}" (via Perplexity):\n\n${answer}`;
    if (cites.length) {
      out += '\n\nSources:\n' + cites.slice(0, 8).map((c, i) => `[${i + 1}] ${c}`).join('\n');
    }
    return out;
  } catch {
    return null;
  }
}

async function searchViaDuckDuckGo(query) {
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return `Error: web search returned HTTP ${r.status}`;
    const html = await r.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null && results.length < 8) {
      let href = m[1];
      // DuckDuckGo wraps each link in a redirect — recover the real target.
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch { /* keep raw */ } }
      if (href.startsWith('//')) href = 'https:' + href;
      const title = htmlToText(m[2]);
      if (title && /^https?:/i.test(href)) results.push(`- ${title}\n  ${href}`);
    }
    if (!results.length) return `No web results found for "${query}".`;
    return `Web search results for "${query}":\n\n${results.join('\n')}\n\n` +
      `Use web_fetch on a URL to read the full page.`;
  } catch (err) {
    return `Web search failed: ${err.name === 'TimeoutError' ? 'request timed out' : err.message}`;
  }
}

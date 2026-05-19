/**
 * Standardized error classification for LLM provider responses.
 *
 * Provider APIs disagree wildly on how they signal quota exhaustion, rate
 * limits, and spend caps. This module turns a raw HTTP status + body into a
 * single `{ kind, retryable, waitMs, message }` verdict so callers (the agent
 * loop, the swarm, the proxy) all back off and surface errors consistently.
 */

export const ErrorKind = {
  QUOTA: 'quota',           // billing / quota exhausted — NOT retryable
  RATE_LIMIT: 'rate_limit', // temporary throttle — retry after waitMs
  AUTH: 'auth',             // missing / invalid key — NOT retryable
  NOT_FOUND: 'not_found',   // unknown model or endpoint — NOT retryable
  BAD_REQUEST: 'bad_request', // malformed payload — NOT retryable
  SERVER: 'server',         // provider 5xx — retryable
  NETWORK: 'network',       // connection failed — retryable
  UNKNOWN: 'unknown',
};

// ErrorKind → Anthropic error `type` string (used by the proxy).
const ANTHROPIC_TYPE = {
  quota: 'rate_limit_error',
  rate_limit: 'rate_limit_error',
  auth: 'authentication_error',
  not_found: 'not_found_error',
  bad_request: 'invalid_request_error',
  server: 'api_error',
  network: 'api_error',
  unknown: 'api_error',
};

/** Pull a retry delay (seconds) from a Retry-After header or error body. */
function parseRetrySeconds(bodyText, headers) {
  const ra = headers?.get?.('retry-after');
  if (ra && /^\d+$/.test(ra.trim())) return parseInt(ra.trim(), 10);
  // Matches: "retryDelay": "40s" · "retry in 40.2s" · "try again in 3s"
  const m = (bodyText || '').match(
    /(?:retry(?:Delay|[-_ ]?after)?["' :]*(?:in\s*)?|try again in\s*)([\d.]+)\s*s?/i
  );
  if (m) return Math.ceil(parseFloat(m[1]));
  return null;
}

/**
 * Classify a non-OK HTTP response from an OpenAI-compatible provider.
 * @param {number} status        - HTTP status code
 * @param {string} [bodyText]    - response body text
 * @param {Headers} [headers]    - response headers (for Retry-After)
 * @returns {{kind:string, retryable:boolean, waitMs:number, message:string}}
 */
export function classifyHttpError(status, bodyText = '', headers = null) {
  const body = bodyText || '';

  // Quota exhaustion — match precise error codes only. Note "billing" appears
  // in URLs inside retryable rate-limit messages too, so we never match on it.
  const isQuota = body.includes('"insufficient_quota"') ||
    body.includes('"exceeded your current quota"') ||
    body.includes('"plan_limit"') ||
    body.includes('"budget_exceeded"');

  if (status === 429) {
    if (isQuota) {
      return {
        kind: ErrorKind.QUOTA, retryable: false, waitMs: 0,
        message: 'Quota exceeded for this provider. Check your plan and billing.',
      };
    }
    let sec = parseRetrySeconds(body, headers);
    if (sec == null) sec = 5;
    sec = Math.min(Math.max(sec, 1), 120);
    return {
      kind: ErrorKind.RATE_LIMIT, retryable: true, waitMs: sec * 1000,
      message: 'Rate limited',
    };
  }

  if (status === 402) {
    // Together AI returns 402 for a per-minute spend cap while credits remain.
    if (body.includes('"credit_limit"') || body.includes('Credit limit exceeded')) {
      return {
        kind: ErrorKind.RATE_LIMIT, retryable: true, waitMs: 30000,
        message: 'Spending rate cap hit',
      };
    }
    return {
      kind: ErrorKind.QUOTA, retryable: false, waitMs: 0,
      message: 'Payment required — provider reports no remaining credits.',
    };
  }

  if (status === 401) {
    return { kind: ErrorKind.AUTH, retryable: false, waitMs: 0, message: 'Unauthorized — check the API key.' };
  }
  if (status === 403) {
    return { kind: ErrorKind.AUTH, retryable: false, waitMs: 0, message: 'Forbidden — the API key lacks access.' };
  }
  if (status === 404) {
    return { kind: ErrorKind.NOT_FOUND, retryable: false, waitMs: 0, message: 'Not found — check the model name or endpoint.' };
  }
  if (status === 400 || status === 422) {
    return { kind: ErrorKind.BAD_REQUEST, retryable: false, waitMs: 0, message: 'Bad request — the provider rejected the payload.' };
  }
  if (status >= 500) {
    return { kind: ErrorKind.SERVER, retryable: true, waitMs: 5000, message: `Provider server error (${status})` };
  }

  return { kind: ErrorKind.UNKNOWN, retryable: false, waitMs: 0, message: `Unexpected HTTP ${status}.` };
}

/** Classify a thrown fetch/connection failure. */
export function classifyNetworkError(err) {
  return {
    kind: ErrorKind.NETWORK, retryable: true, waitMs: 2000,
    message: `Connection failed: ${err?.message || err}`,
  };
}

/** ErrorKind → Anthropic error `type` string. */
export function anthropicErrorType(kind) {
  return ANTHROPIC_TYPE[kind] || 'api_error';
}

/** ErrorKind → the HTTP status the proxy should return to its client. */
export function anthropicHttpStatus(kind) {
  switch (kind) {
    case ErrorKind.AUTH: return 401;
    case ErrorKind.NOT_FOUND: return 404;
    case ErrorKind.BAD_REQUEST: return 400;
    case ErrorKind.RATE_LIMIT:
    case ErrorKind.QUOTA: return 429;
    default: return 502;
  }
}

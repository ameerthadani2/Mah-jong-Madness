/**
 * Turns an error from the network, the game server or the clubs API into a sentence
 * a player can act on. Known failure shapes get fixed copy; short, human-readable
 * server messages (the clubs API's own copy) pass through; anything technical is
 * replaced with a generic line.
 */

const TIMEOUT = 'The game server took too long to answer. Check your connection and try again.';
const GENERIC = 'Something went wrong. Please try again.';

/** Checked in order: the first match wins. */
const RULES: ReadonlyArray<{ test: RegExp; text: string }> = [
  { test: /timed? ?out|timeout|aborted/i, text: TIMEOUT },
  { test: /too many|rate.?limit|slow down|\b429\b/i, text: 'Too many attempts in a short time. Wait a few seconds and try again.' },
  { test: /room (?:is )?(?:not found|full)|not found or full/i, text: 'No open table with that code. Check the code; the table may also be full.' },
  {
    test: /network request failed|failed to fetch|load failed|signaling connection failed|connection (?:closed|refused|failed|lost)|not connected|websocket|econnrefused|enotfound|socket hang up/i,
    text: 'Cannot reach the game server. Check your connection and try again.',
  },
  { test: /capacity|server is full|no tables available/i, text: 'The game server is busy right now. Please try again in a minute.' },
  { test: /request failed \(\d{3}\)|internal server error/i, text: 'The game server had a problem. Please try again later.' },
];

/** Messages that read like code, stack traces or error codes rather than copy. */
const TECHNICAL = /[{}<>[\]]|\bat \S+:\d+|\bundefined\b|\bnull\b|\bNaN\b|is not a function|cannot read|unexpected (?:token|end)|\bjson\b|^[a-z]+(?:_[a-z]+)+$|^[a-z]+$/i;

function field(e: unknown, key: 'message' | 'name'): string {
  if (typeof e === 'string') return key === 'message' ? e : '';
  if (e && typeof e === 'object' && key in e) {
    const v = (e as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

export function friendlyError(e: unknown): string {
  const name = field(e, 'name');
  if (name === 'AbortError' || name === 'TimeoutError') return TIMEOUT;
  const msg = field(e, 'message').trim();
  if (!msg) return GENERIC;
  for (const r of RULES) if (r.test.test(msg)) return r.text;
  if (name === 'SyntaxError' || name === 'TypeError' || name === 'ReferenceError') return GENERIC;
  if (msg.length > 120 || TECHNICAL.test(msg)) return GENERIC;
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

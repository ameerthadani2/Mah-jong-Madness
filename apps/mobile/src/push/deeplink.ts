/**
 * Deep links into the app, from a tapped notification or a `<scheme>://` URL.
 *
 *   <scheme>://club/<CODE>                 open that club
 *   <scheme>://table/<ROOM>[?club=<CODE>]  take a seat at that table (falling back to its club)
 *
 * A notification carries either `data.url` (one of the links above) or the same parts as fields:
 * `{ "type": "club", "club": "<CODE>" }` or `{ "type": "table", "room": "<ROOM>", "club"?: "<CODE>" }`.
 * Anything else is ignored. Pure TypeScript, tested in deeplink.test.ts.
 */

export type DeepLink = { kind: 'club'; club: string } | { kind: 'table'; room: string; club?: string };

/** Club and room codes are short upper-case letters and digits. */
const CODE = /^[A-Z0-9]{4,12}$/;

function code(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const c = x.trim().toUpperCase();
  return CODE.test(c) ? c : null;
}

function link(kind: unknown, first: unknown, club: unknown): DeepLink | null {
  if (kind === 'club') {
    const c = code(first);
    return c ? { kind: 'club', club: c } : null;
  }
  if (kind === 'table') {
    const room = code(first);
    if (!room) return null;
    const c = code(club);
    return c ? { kind: 'table', room, club: c } : { kind: 'table', room };
  }
  return null;
}

/** Parses `<scheme>://club/ABCD` or `<scheme>://table/WXYZ?club=ABCD` for one of the app's schemes. */
export function parseDeepLink(url: string | null | undefined, schemes: readonly string[]): DeepLink | null {
  if (typeof url !== 'string') return null;
  const m = /^([a-z][a-z0-9+.-]*):\/\/+([^?#]*)(?:\?([^#]*))?/i.exec(url.trim());
  if (!m || !schemes.some((s) => s.toLowerCase() === m[1].toLowerCase())) return null;
  const parts = m[2].split('/').filter(Boolean).map(safeDecode);
  const query = new Map<string, string>();
  for (const pair of (m[3] ?? '').split('&')) {
    const [k, v = ''] = pair.split('=');
    if (k) query.set(safeDecode(k), safeDecode(v));
  }
  return link(parts[0]?.toLowerCase(), parts[1], query.get('club'));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Reads a notification's `data` payload. */
export function linkFromNotificationData(data: unknown, schemes: readonly string[]): DeepLink | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.url === 'string') return parseDeepLink(d.url, schemes);
  return link(d.type, d.type === 'club' ? d.club : d.room, d.club);
}

/** What following a link does, given where the player is now. */
export type LinkPlan =
  /** Already at that table: just show it. */
  | { kind: 'show-table' }
  | { kind: 'open-club'; club: string }
  /** Take a seat (the caller falls back to `fallbackClub`, if any, when the seat cannot be taken). */
  | { kind: 'join-table'; room: string; club?: string };

export function planLink(l: DeepLink, here: { roomCode: string | null }): LinkPlan {
  if (l.kind === 'club') return { kind: 'open-club', club: l.club };
  if (here.roomCode && here.roomCode.toUpperCase() === l.room) return { kind: 'show-table' };
  return l.club ? { kind: 'join-table', room: l.room, club: l.club } : { kind: 'join-table', room: l.room };
}

/** While the app is open, a notification about the table the player is already at is not shown again. */
export function presentInForeground(l: DeepLink | null, here: { roomCode: string | null }): boolean {
  return !(l && l.kind === 'table' && here.roomCode && here.roomCode.toUpperCase() === l.room);
}

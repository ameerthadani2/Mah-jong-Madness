/**
 * Table events, derived from successive client states. Pure: the same pair of states always yields the
 * same events, so the table's sounds and call-out banners can be tested without React or a device.
 *
 * A "call" (吃 碰 槓 胡 自摸) is both a voice cue and a centre-table banner; the other events are sound only.
 */
import type { ClientState } from '@mjm/net';

export type CallKind = 'chi' | 'pong' | 'kong' | 'hu' | 'selfdraw';
export type SfxCue = 'draw' | 'discard' | 'drawGame' | 'fanfare' | 'tick' | 'tap';

export type TableEvent =
  | { type: 'sfx'; cue: SfxCue }
  /** A seat called: shown as a banner and spoken in the chosen voice. */
  | { type: 'call'; call: CallKind; seat: number };

export const CALL_KINDS: readonly CallKind[] = ['chi', 'pong', 'kong', 'hu', 'selfdraw'];

/** The part of a client state the cue logic reads (keeps tests small). */
export type CueState = Pick<ClientState, 'view' | 'lastResult' | 'lastAudit'> & { seat: number | null };

const resultKey = (s: CueState | null) => (s?.lastResult ? `${s.lastAudit?.matchId ?? ''}:${s.lastAudit?.handNumber ?? s.view?.handNumber ?? ''}:${s.lastResult.type}` : null);

/**
 * Events for the step from `prev` to `next`. `prev` null (first render, or the table remounting) yields
 * nothing, so returning to the table never replays old calls.
 */
export function tableEvents(prev: CueState | null, next: CueState | null): TableEvent[] {
  if (!prev || !next || !next.view) return [];
  const out: TableEvent[] = [];
  const pv = prev.view;
  const nv = next.view;
  const me = next.seat ?? 0;
  const sameHand = !!pv && pv.handNumber === nv.handNumber;

  if (sameHand && pv) {
    nv.players.forEach((p, seat) => {
      const before = pv.players[seat];
      if (!before) return;
      if (p.discards.length > before.discards.length) out.push({ type: 'sfx', cue: 'discard' });
      if (p.melds.length > before.melds.length) {
        const m = p.melds[p.melds.length - 1];
        out.push({ type: 'call', call: m.type === 'chow' ? 'chi' : m.type === 'pong' ? 'pong' : 'kong', seat });
      } else {
        // A pong promoted to a kong keeps the meld count.
        const kongs = (melds: typeof p.melds) => melds.filter((m) => m.type === 'kong').length;
        if (kongs(p.melds) > kongs(before.melds)) out.push({ type: 'call', call: 'kong', seat });
      }
    });
    // My own draw: the drawn tile changed while it is my turn to discard.
    if (nv.phase === 'discard' && nv.turn === me && nv.lastDrawn != null && nv.lastDrawn !== pv.lastDrawn) out.push({ type: 'sfx', cue: 'draw' });
  }

  const rk = resultKey(next);
  if (rk && rk !== resultKey(prev) && next.lastResult) {
    const res = next.lastResult;
    if (res.type === 'win') {
      for (const w of res.wins) out.push({ type: 'call', call: w.selfDrawn ? 'selfdraw' : 'hu', seat: w.seat });
      if (res.wins.some((w) => w.seat === me)) out.push({ type: 'sfx', cue: 'fanfare' });
    } else {
      out.push({ type: 'sfx', cue: 'drawGame' });
    }
  }
  return out;
}

/** The clock ticks once per second for the last five seconds of my own move. */
export function shouldTick(prev: number | null, next: number | null, myMove: boolean): boolean {
  return myMove && next !== null && next > 0 && next <= 5 && next !== prev;
}

/** The manifest id of a call's voice line in a voice set, or null when voice is off. */
export function voiceCueId(call: CallKind, voice: VoicePreference): string | null {
  return voice === 'off' ? null : `voice.${voice}.${call}`;
}

export type VoicePreference = 'mandarin' | 'taiwanese' | 'off';
export const VOICE_PREFERENCES: readonly VoicePreference[] = ['mandarin', 'taiwanese', 'off'];
export const DEFAULT_VOICE: VoicePreference = 'mandarin';

export function isVoicePreference(x: unknown): x is VoicePreference {
  return typeof x === 'string' && (VOICE_PREFERENCES as readonly string[]).includes(x);
}

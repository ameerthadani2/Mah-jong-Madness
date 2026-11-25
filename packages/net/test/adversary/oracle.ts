/**
 * The oracle: from the ground truth of a run (truth.ts), which hands the server cheated the player in, and whether the
 * phone said so.
 *
 * A hand is cheated when, in it:
 * - `forgedPlayer`: the log credits the player with a move its phone never sent, outside a stretch another device of
 *   the player's really held the seat;
 * - `tableEarly`: the table moved for the player (its published rule's move) before the seat's whole clock could have
 *   run out, by more than the clock allowance the charter states; `tableWrong`: the table moved for it with a move its
 *   rule does not give;
 * - `badSeed`: the deal came from a server share picked after the phone revealed its own;
 * - `doctoredView`: the phone was shown a view of the table that is not the true one (its hash kept);
 * - `droppedMove`: a legal move of the phone's was lost on the server's side and another move of the phone's, sent on the
 *   same link, was played while the lost one was still legal; `refusedLegal`: the server refused, naming its turn, a move
 *   that was legal; `droppedForTable`: such a lost move, sent in good time, was played over by the table;
 * - `withheldPlay`: the table played a decision whose state the server kept from the phone on a link the phone held, up
 *   since before the deal or since the phone was shown the hand, whose pings it answered meanwhile;
 * - `evictedBack`: the server said the seat was taken away (`evicted`), the table played the decision the phone showed
 *   meanwhile (its player was kept from moving), and the server then went on with the game on that same link.
 *
 * The properties: (a) a cheated hand is never shown green, and amber only where every cheat in it is a case
 * docs/FAIRNESS.md states as a limit (`EXCEPTIONS`, each with the charter's own words), and the end of a match with a
 * cheated hand is never shown verified; a hand the phone once showed red is never shown otherwise after; (b) an honest
 * scenario never shows red; (c) the runner prints every failure with its seed and a shortest event list that replays it.
 * Each failure is named by the known gap it matches (`KNOWN`), or `new`.
 */
import { readFileSync } from 'node:fs';
import type { Action } from '@mjm/engine';
import { BY_MATCH, engine, fairnessDocPath, net } from './load';
import { isHonest, type Scenario } from './scenario';
import type { DecisionInfo, LogMove, MoveContext, RunInfo, Truth, Verdict } from './truth';

export type CheatKind = 'forgedPlayer' | 'tableEarly' | 'tableWrong' | 'badSeed' | 'doctoredView' | 'droppedMove' | 'refusedLegal' | 'droppedForTable' | 'withheldPlay' | 'evictedBack';

export interface Cheat {
  kind: CheatKind;
  hand: number;
  turn: number;
  at: number;
  what: string;
  /** The stated limits that cover it (amber allowed when every cheat of the hand has one). */
  excuses: ExceptionName[];
  /** Features of the case, for naming the known gap. */
  tags: string[];
}

export type Property = 'green' | 'amber' | 'endVerified' | 'noVerdict' | 'redForgotten' | 'falseRed' | 'crash';

export interface Violation {
  property: Property;
  hand: number | null;
  verdict: string;
  cheats: Cheat[];
  /** The known gap it matches (`KNOWN`), or 'new'. */
  known: string;
  detail: string;
}

// ------------------------------------------------------------------- stated limits

export type ExceptionName = 'restoredLedger' | 'otherDevice' | 'missedHand' | 'partWay' | 'noRecordJoin' | 'otherMatch' | 'noMeasure' | 'noTimelyView' | 'restartClock' | 'inFlight' | 'serverRewind' | 'standIn';

/**
 * The cases docs/FAIRNESS.md states as limits: a cheat covered by one may be amber. Each stated limit: the charter's words (`quote`), what the oracle lets through under it (`covers`), and whether the
 * charter keeps the end of the match from being shown verified when it applies (`end`: `unverified`, with its words in
 * `endQuote`; `unstated`: the charter lists what keeps the end unverified and this case is not on that list).
 */
export interface StatedLimit {
  quote: string;
  covers: string;
  end: 'unverified' | 'unstated';
  endQuote?: string;
}

export const EXCEPTIONS: Record<ExceptionName, StatedLimit> = {
  restoredLedger: {
    quote: "without the journal (a record written by an earlier build of the app, a journal that storage damaged, or one the phone could not write), a move credited to you at the latest saved state's turn or later, before the restored app is shown the table again, is not checked against your moves when the server shows the table right behind its welcome",
    covers: "a move credited to the player at or after the latest state of the record a restored client loaded without the app's journal of the match, made while the player's app was not running (or in the 0.6 s before it stopped), before the restored client was shown the hand",
    end: 'unstated',
  },
  otherDevice: {
    quote: 'a move it credits to you that your phone did not send, from the latest turn your phone was shown until your phone is shown the hand again, cannot be told from one made there',
    covers: 'a move made from the latest turn the phone was shown until it is shown the hand again, when the server said another device held the seat: a seat-taken notice or a rejoin welcome saying so (taken after the move, before a later state reached that run, or before it), or the first welcome of a later run of the client saying so (the move at or after the latest turn of the record that run held)',
    end: 'unverified',
    endQuote: 'and the end of the match is not shown as verified',
  },
  missedHand: {
    quote: 'a move written down as your own is held to the table\'s rule and to your time away like any other',
    covers: "a move written as the player's in a hand the phone was shown nothing of and took no part in the deal of, when it is the table's rule's move and comes after the seat's whole clock",
    end: 'unverified',
    endQuote: 'a match end reached through a missed hand with moves for your seat is not shown as verified',
  },
  partWay: {
    quote: 'or that came to a hand part-way through after moves were made for its seat in it: it checked those hands as far as it could, but it did not watch those moves, so the end is not shown as verified',
    covers: "a move of the table's rule credited to the seat in a hand the phone took no part in the deal of, before it was first shown the hand, that fits in the time it was away",
    end: 'unverified',
    endQuote: 'it did not watch those moves, so the end is not shown as verified',
  },
  noTimelyView: {
    quote: 'If the table then plays for you, its move is judged as one made while you had no timely view of the table: amber, or red when a whole clock cannot have run out.',
    covers: "a table move for the player at a turn whose state had not reached the phone, when what the phone was shown leaves room for the seat's whole clock (from the last frame of the hand it was shown before the move to the first after)",
    end: 'unstated',
  },
  noRecordJoin: {
    quote: 'Such a phone did not watch the moves credited to your seat in that hand before it was first shown the hand, so, like the moves of a hand it missed, they keep the end of the match from being shown as verified.',
    covers: 'a move made before a phone with no record of the table was first shown the hand, when the record was lost the ways the charter states (another phone; before unit 20g also the archive\'s day or three tables; since, its thirty days, or records holding red hands filling its million characters)',
    end: 'unverified',
    endQuote: 'they keep the end of the match from being shown as verified',
  },
  otherMatch: {
    quote: 'a server that seats your account again under another match id keeps the kept record from being taken up; the hand that record was on then never gets a verdict',
    covers: 'no verdict for the hand a record was on, when the server seated the account again under another match id',
    end: 'unstated',
  },
  noMeasure: {
    quote: 'Where your phone has no measure of the time (you left the table yourself, your seat was opened on another device, or the app was restarted in between) the table\'s moves for you are noted in amber and not judged.',
    covers: "a table move for the player while the phone had taken a seat-taken notice, or across a new run of the player's client during the decision",
    end: 'unstated',
  },
  restartClock: {
    quote: 'If the server says it restarted while you owed a move, and then plays that move for you, the hand is amber',
    covers: 'a table move for the player after a restart notice reached the phone during that decision',
    end: 'unstated',
  },
  inFlight: {
    quote: 'A move you sent in good time that the table plays over with a move of its own is amber (red once the table plays another move you sent later over the same connection, which stayed up',
    covers: "a legal move lost on the server's side, sent in good time, played over by the table's own move (no later move of the phone's sent on the same link played while the lost one was still legal: that is `droppedMove`)",
    end: 'unstated',
  },
  serverRewind: {
    quote: 'Your phone then drops what it had been shown beyond that point, once per hand, and only what had reached it over a connection that has since been lost',
    covers: 'a changed view shown beyond the turn a later restart notice names, on a link since lost',
    end: 'unstated',
  },
  standIn: {
    quote: 'A server that re-deals after seeing your secret therefore either fails your audit or must stand you in.',
    covers: 'a deal the server chose after the phone revealed, when the phone was stood in for it',
    end: 'unstated',
  },
};

/** What the charter says the phone cannot tell, used to leave cases out of the cheats (they are not detectable at all). */
export const UNDETECTABLE = {
  lastMoment: 'a move you sent in the last 1.5 seconds your screen showed, which the server says arrived too late, looks the same as a slow network',
  clockAllowance: 'The server\'s time stamps are believed up to 5 seconds beyond your phone\'s own clock (30 seconds until the table first answers a ping',
} as const;

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/\*\*/g, '');

/** The quotes that are not in docs/FAIRNESS.md (word for word): none, while the oracle and the charter agree. */
export function quotesMissing(doc = readFileSync(fairnessDocPath, 'utf8')): string[] {
  const d = norm(doc);
  const quotes = [...Object.entries(EXCEPTIONS).flatMap(([k, v]) => [[k, v.quote] as const, ...(v.endQuote ? [[`${k}.end`, v.endQuote] as const] : [])]), ...Object.entries(UNDETECTABLE)];
  return quotes.filter(([, q]) => !d.includes(norm(q))).map(([k]) => k);
}

// ------------------------------------------------------------------- the cheats of a run

/** How far ahead of the seat's whole clock a table move may come without the phone being able to tell (the charter's 5 s, or 30 s before the first answer to a ping), with a margin. */
const allowance = (ctx: MoveContext) => (ctx.fixedPoint ? 7_000 : 31_000);
/** The last moments of a turn in which a lost move looks like a slow network (1.5 s, the round trip, a margin). */
const LAST_MOMENT_MS = 3_000;
const REFUSALS = new Set(['illegal', 'not_playing', 'wrong_seat']);

const sameMove = (a: Action, b: Action) => {
  if (a.type !== b.type) return false;
  if (a.type === 'discard' || a.type === 'kong') return engine.kindOf(a.tile) === engine.kindOf((b as typeof a).tile);
  if (a.type === 'chi') {
    const k = (x: { tiles: [number, number] }) => x.tiles.map((t) => engine.kindOf(t)).sort().join(',');
    return k(a) === k(b as typeof a);
  }
  return true;
};

/** The run that judged a hand: the last one holding a verdict for it (or, when none does, the last run). */
function judgeOf(t: Truth, hand: number): RunInfo | undefined {
  return [...t.runs].reverse().find((r) => r.shown?.audits.has(hand)) ?? t.runs[t.runs.length - 1];
}

/**
 * The phone's record of the table was lost a way the charter states: another phone (and before the app kept its records by
 * match, unit 20g, the archive's day or three other tables; the routes the fuzzer models no longer lose it since).
 */
const statedLoss = (t: Truth): boolean => t.freshPhones > 0 || (!BY_MATCH && t.goneRoutes.some((r) => r === 'expired' || r === 'pushed'));

/**
 * The phone that judged `hand` started from no record (a new phone, or a token alone) after what happened at `at` on
 * client run `run`: the run it started from was made after that run and was first shown the hand after that moment.
 * Such a phone cannot know what an earlier phone was sent or shown. Returns the run it started from.
 */
function blindJudge(t: Truth, hand: number, at: number, run: number | null): RunInfo | null {
  const judge = judgeOf(t, hand);
  if (!judge) return null;
  const base = [...t.runs].filter((r) => r.run <= judge.run && (r.how === 'fresh' || r.how === 'token')).pop();
  // A run that took a kept record up at its first welcome (the lookup by match) holds what that record held.
  if (!base || base.tookUpAtWelcome) return null;
  if (run !== null && base.run <= run) return null;
  if ((base.firstShown.get(hand) ?? Infinity) <= at) return null;
  return base;
}

/**
 * What reached client run `run` at `at` never reached the run that judged `hand`: a later run took up a record saved
 * before `at` (the app stopped within its save delay), or the hand was judged by no run that holds it. The phone cannot
 * judge what it does not hold, so such a cheat is left out.
 */
function evidenceLost(t: Truth, hand: number, run: number, at: number): boolean {
  const judge = judgeOf(t, hand);
  if (!judge || judge.run === run) return false;
  if (judge.run < run) return true;
  for (const r of t.runs) {
    if (r.run <= run || r.run > judge.run) continue;
    if (r.how === 'restore' || r.how === 'archive') {
      // A restore takes up the record the app holds in memory (written to the device or not); for an archived one, the last save.
      const save = r.recordAt ?? t.saveTimes.filter((x) => x <= r.createdAt).pop() ?? -Infinity;
      if (save < at) return true;
    }
  }
  return false;
}

/** Excuses and tags for a cheat a phone with no record judged: amber is stated when the record was lost a stated way. */
function blindness(t: Truth, hand: number, at: number, run: number | null, excuses: ExceptionName[], tags: string[]): void {
  if (!blindJudge(t, hand, at, run)) return;
  tags.push('freshJudge');
  if (statedLoss(t)) excuses.push('noRecordJoin');
  // A stand-in notice for the hand, taken by a phone that was not shown its deal.
  if (t.stoodIn.has(hand)) tags.push('stoodIn');
}

/**
 * A later run of the client was welcomed with word that another device had held the seat, after the move and before it
 * was first shown the hand, and the move is at or after the latest turn of the record that run held: from the latest turn
 * the phone was shown until it is shown the hand again, such a move cannot be told from one made on another device.
 */
function elsewhereAfter(t: Truth, lm: LogMove): boolean {
  return t.runs.some((r) => r.run > lm.ctx.run && r.elsewhereAt !== null && r.elsewhereAt >= lm.at && lm.at <= (r.firstShown.get(lm.hand) ?? Infinity) && lm.n >= (r.recordLatest.get(lm.hand) ?? -1));
}

/** A seat-taken notice reached the run the move was made in after the move, before a later state of the hand reached it. */
function kickedAfter(t: Truth, lm: LogMove): boolean {
  const { to } = seenAround(t, lm);
  return t.kicks.some((k) => k.run === lm.ctx.run && k.at >= lm.at && k.at <= to);
}

/**
 * The move falls in the stretch the restored-ledger limit states: a client taken up from a record after it, before that
 * client was shown the hand, at or after the latest state the record holds, made while the app was not running or in the
 * moment before it stopped (the save delay, with a margin).
 */
function inRestoredStretch(t: Truth, lm: LogMove): boolean {
  const ctx = lm.ctx;
  const restored = t.runs.find((r) => r.run > ctx.run && r.createdAt >= lm.at && (r.how === 'restore' || r.how === 'archive' || r.tookUpAtWelcome));
  // With the app's journal of the match the restored client knows every move it sent: the limit does not apply.
  if (!restored || restored.journal) return false;
  const latest = restored.recordLatest.get(lm.hand) ?? -1;
  const shownAt = restored.firstShown.get(lm.hand) ?? Infinity;
  const prev = t.runs.find((r) => r.run === ctx.run);
  const stopped = !ctx.hasClient || !ctx.appRunning || (prev?.endedAt != null && prev.endedAt - lm.at <= 600 && prev.endedAt >= lm.at);
  // Within one step of the fake clock the server acts before the phone takes its frames, so a tie is before.
  return lm.n >= latest && lm.at <= shownAt && stopped;
}

/**
 * The phone sent this very move on an earlier turn of the hand and never saw it played or refused: an honest table plays a
 * move when it comes, on a later turn where it is legal (docs/API.md: "the host plays the first that is legal when it
 * comes, a late one on a later turn"), so to the phone the log's entry is its own move, played late. (A server that
 * refuses it and keeps the refusal from the phone can play it so; the move is still one the player made.)
 */
function playedLate(t: Truth, lm: LogMove): boolean {
  return t.sent.some(
    (s) =>
      s.hand === lm.hand &&
      s.tc !== null &&
      s.tc < lm.n &&
      s.at <= lm.at &&
      sameMove(s.action, lm.action) &&
      !t.log.some((x) => x !== lm && x.origin === 'victim' && x.line === s.line && x.msgTc === s.tc && x.at >= s.at && sameMove(x.action, s.action)) &&
      !t.refusalsSeen.some((r) => r.line === s.line && r.turn === s.tc && r.at >= s.at && r.at <= lm.at),
  );
}

function forgedPlayer(t: Truth, lm: LogMove): Cheat | null {
  if (t.sent.some((s) => s.hand === lm.hand && s.tc === lm.n && sameMove(s.action, lm.action))) return null;
  if (playedLate(t, lm)) return null;
  const ctx = lm.ctx;
  const excuses: ExceptionName[] = [];
  const tags: string[] = [];
  if (inRestoredStretch(t, lm)) {
    excuses.push('restoredLedger');
    tags.push('appDown');
  }
  // From the latest turn the phone was shown until it is shown the hand again, once the server says another device held
  // the seat: also a move made before that word came, after the last state the phone was shown.
  if (ctx.kicked || kickedAfter(t, lm) || elsewhereAfter(t, lm)) excuses.push('otherDevice');
  const tookPart = [...t.lines.values()].some((l) => l.committed.has(lm.hand) || l.revealed.has(lm.hand));
  // A hand the phone was shown nothing of before the move, and took no part in the deal of: the move is the table's.
  if (!ctx.shownHand && !tookPart && ctx.isRuleMove && fitsAway(t, lm)) excuses.push(t.runs.some((r) => r.firstShown.has(lm.hand)) ? 'partWay' : 'missedHand');
  blindness(t, lm.hand, lm.at, null, excuses, tags);
  // A stand-in notice for the hand reached the phone (before or after the move), which was not shown the hand before it.
  if (t.stoodIn.has(lm.hand) && !ctx.shownHand && !tags.includes('stoodIn')) tags.push('stoodIn');
  // A seat-taken notice taken then, or later in the same run before the phone was shown the hand again.
  if (ctx.kicked || kickedAfter(t, lm)) tags.push('kicked');
  const cur = t.runs.find((r) => r.run === ctx.run);
  if (cur && cur.how !== 'initial' && !ctx.shownThisRun && ctx.hasClient) tags.push('afterRestore');
  // Made while the app ran, before a client taken up from a record (a Resume, a restart, the archive).
  if (ctx.hasClient && ctx.appRunning && !tags.includes('appDown') && t.runs.some((r) => r.run > ctx.run && r.createdAt >= lm.at && (r.how === 'restore' || r.how === 'token' || r.how === 'archive'))) tags.push('beforeResume');
  if (lm.decision && !lm.decision.reached.some((x) => x.at <= lm.at)) tags.push('unshown');
  return { kind: 'forgedPlayer', hand: lm.hand, turn: lm.n, at: lm.at, what: `${JSON.stringify(lm.action)} written as the player's own`, excuses, tags };
}

/**
 * What the phone was shown around a move for its seat: the last frame of the hand that reached it before the move (`from`;
 * the commit request or the reveal when it was shown nothing of the hand yet), and the first after it (`to`: a later
 * turn's state or the hand's result). The phone can place the move nowhere closer.
 */
function seenAround(t: Truth, lm: LogMove): { from: number; to: number; sawTurn: boolean } {
  let from = -Infinity;
  let to = Infinity;
  let sawTurn = false;
  for (const [key, xs] of t.statesReached) {
    const [h, tc] = key.split(':').map(Number);
    if (h !== lm.hand) continue;
    for (const x of xs) {
      if (tc <= lm.n && x.at <= lm.at) from = Math.max(from, x.at);
      if (tc === lm.n && x.at <= lm.at) sawTurn = true;
      if (tc > lm.n) to = Math.min(to, x.at);
    }
  }
  if (from === -Infinity) for (const li of t.lines.values()) if (li.committed.has(lm.hand) || li.revealed.has(lm.hand)) from = Math.max(from, li.openedAt);
  const result = t.resultsReached.get(lm.hand);
  if (result !== undefined) to = Math.min(to, result);
  return { from, to, sawTurn };
}

/**
 * The phone lost its measure before it could place the table's move: the seat was said to be opened on another device,
 * the app stopped, or a new run of its client began, between the last frame of the hand it was shown before the move and
 * the first after (it cannot tell whether the move came before or after).
 */
function measureLost(t: Truth, lm: LogMove): boolean {
  const { from, to } = seenAround(t, lm);
  const inside = (at: number) => at >= from && at <= to;
  return t.kicks.some((k) => inside(k.at)) || t.runs.some((r) => r.run > lm.ctx.run && inside(r.createdAt)) || t.appStops.some((x) => inside(x.at));
}

/** What the phone was shown around the table's move leaves room for the seat's whole clock: it cannot tell the move was early. */
function noTimelyView(t: Truth, lm: LogMove): boolean {
  const d = lm.decision;
  const w = seenAround(t, lm);
  if (!d) return false;
  // Shown the turn or not, the phone can place the move no closer than between the frames it was shown around it.
  return w.to - w.from >= d.deadline - d.startedAt - allowance(lm.ctx);
}

/**
 * The moves for the seat in a hand the phone missed (or came to part-way) fit in the time it was away: each needs at least
 * the turn clock, from the deal to the phone's first sight of the hand (or the hand's result).
 */
function fitsAway(t: Truth, lm: LogMove): boolean {
  const first = Math.min(...t.runs.map((r) => r.firstShown.get(lm.hand) ?? Infinity), t.resultsReached.get(lm.hand) ?? Infinity);
  const deal = t.dealtAt.get(lm.hand);
  if (deal === undefined) return false;
  const moves = t.log.filter((x) => x.hand === lm.hand && x.at < first && x.origin !== 'victim' && x.origin !== 'other').length;
  return moves * t.sim.rules.turnSeconds * 1000 <= first - deal + allowance(lm.ctx);
}

/** The decision's state went out on a link that was up before the deal, never reached the phone there, and the link ended. */
function heldOnEndedLink(t: Truth, d: DecisionInfo | null): boolean {
  if (!d) return false;
  return d.sentOn.some((s) => {
    const li = t.lines.get(s.line);
    if (!li || li.closedAt === null || d.reached.some((x) => x.line === li.n)) return false;
    return li.committed.has(d.hand) || li.revealed.has(d.hand) || [...li.brought].some((h) => h < d.hand);
  });
}

function tableMove(t: Truth, lm: LogMove): Cheat | null {
  const ctx = lm.ctx;
  const excuses: ExceptionName[] = [];
  const tags: string[] = [];
  if (!ctx.isRuleMove) {
    if (ctx.kicked) excuses.push('otherDevice');
    blindness(t, lm.hand, lm.at, null, excuses, tags);
    return { kind: 'tableWrong', hand: lm.hand, turn: lm.n, at: lm.at, what: `${JSON.stringify(lm.action)} played by the table, not its rule's move`, excuses, tags };
  }
  if (ctx.earlyBy <= allowance(ctx)) return null;
  if (heldOnEndedLink(t, lm.decision)) tags.push('linkEnded');
  if (t.stoodIn.has(lm.hand)) tags.push('stoodIn');
  if (ctx.kicked || ctx.runChanged || !ctx.hasClient || measureLost(t, lm)) excuses.push('noMeasure');
  if (noTimelyView(t, lm)) excuses.push('noTimelyView');
  const tookPart = [...t.lines.values()].some((l) => l.committed.has(lm.hand) || l.revealed.has(lm.hand));
  if (!ctx.shownHand && !tookPart && fitsAway(t, lm)) excuses.push(t.runs.some((r) => r.firstShown.has(lm.hand)) ? 'partWay' : 'missedHand');
  if (ctx.restoredNotice) excuses.push('restartClock');
  blindness(t, lm.hand, lm.at, null, excuses, tags);
  return { kind: 'tableEarly', hand: lm.hand, turn: lm.n, at: lm.at, what: `the table's move ${(ctx.earlyBy / 1000).toFixed(1)} s before the seat's clock ran out`, excuses, tags };
}

/**
 * The decision's state was kept from the phone on a link it held, and the table played it: on that link an answer to a
 * ping the host sent after the state reached the phone while the state did not (a connection delivers in order, so only
 * a server holding the state back does that), on a link that was up before the deal or had shown the phone the hand.
 */
function withheld(t: Truth, d: DecisionInfo): Cheat | null {
  const lm = d.playedBy;
  if (!lm || lm.origin === 'victim' || lm.origin === 'other' || d.playedAt === null) return null;
  if (lm.ctx.kicked || lm.ctx.evicted) return null;
  const playedAt = d.playedAt;
  for (const s of d.sentOn) {
    const li = t.lines.get(s.line);
    if (!li) continue;
    if (li.welcomedAt === null || li.welcomedAt > s.at) continue;
    const reachedAt = d.reached.find((x) => x.line === li.n)?.at ?? Infinity;
    // An answer sent after the state, that reached the phone before it, before the table played the turn.
    if (!li.pongs.some((p) => p.sentAt > s.at && p.at <= playedAt && p.at < reachedAt)) continue;
    const shownBefore = (li.firstStateAt.get(d.hand) ?? Infinity) < s.at;
    const upBefore = li.committed.has(d.hand) || li.revealed.has(d.hand) || [...li.brought].some((h) => h < d.hand);
    if (!shownBefore && !upBefore) continue;
    const tags: string[] = [];
    const excuses: ExceptionName[] = [];
    const first = [...t.lines.values()].filter((x) => x.revealed.has(d.hand)).sort((a, b) => a.n - b.n)[0];
    if (li.revealed.has(d.hand) && first && first.n !== li.n) tags.push('revealedAgain');
    if (!shownBefore) tags.push('neverShownOnLink');
    // The link went before the turn's state reached the phone on it.
    if (li.closedAt !== null && reachedAt === Infinity) tags.push('linkEnded');
    blindness(t, d.hand, s.at, li.run, excuses, tags);
    return { kind: 'withheldPlay', hand: d.hand, turn: d.tc, at: playedAt, what: `turn ${d.tc}'s state kept from the phone on link ${li.n} (an answer to a ping sent after it came first) while the table played it (${lm.origin === 'forged' ? `forged ${lm.source}` : 'timeout'})`, excuses, tags };
  }
  return null;
}

export function cheatsOf(t: Truth): Cheat[] {
  const out: Cheat[] = [];
  for (const lm of t.log) {
    if (lm.origin !== 'forged') continue;
    const c = lm.source === 'player' ? forgedPlayer(t, lm) : tableMove(t, lm);
    if (c) out.push(c);
  }
  for (const d of t.decisions.values()) {
    const c = withheld(t, d);
    if (c) out.push(c);
  }
  for (const d of t.dropped) {
    if (!d.legal) continue;
    const late = d.refusals.filter((r) => r.afterState).length;
    const tags = [`refusals:${d.refusals.length}`, ...(late >= 2 ? ['lateRefusals'] : late === 1 ? ['lateRefusal'] : [])];
    const blind: ExceptionName[] = [];
    blindness(t, d.hand, d.at, d.run, blind, tags);
    if (d.replacedBy) {
      if (d.replacedBy.n > d.hostTc) tags.push('bump');
      // The move played in its place is one the restored-ledger limit leaves unchecked.
      const stretch: ExceptionName[] = inRestoredStretch(t, d.replacedBy) ? ['restoredLedger'] : [];
      const by = d.replacedBy.ctx;
      const cur = t.runs.find((r) => r.run === by.run);
      if (cur && cur.how !== 'initial' && !by.shownThisRun && by.hasClient) tags.push('afterRestore');
      if (by.kicked || kickedAfter(t, d.replacedBy)) tags.push('kicked');
      out.push({ kind: 'droppedMove', hand: d.hand, turn: d.hostTc, at: d.at, what: `${JSON.stringify(d.action)} lost on the server's side, then ${JSON.stringify(d.replacedBy.action)} of the same link played at turn ${d.replacedBy.n} while it was still legal`, excuses: [...blind, ...stretch], tags });
    }
    for (const r of d.refusals) {
      if (!REFUSALS.has(r.code) || !r.legalNow || r.turn !== (d.msgTc ?? d.hostTc)) continue;
      // A refusal the phone never got, or lost with a record saved before it came, tells the phone nothing.
      if (r.reachedAt === null || r.run === null || evidenceLost(t, d.hand, r.run, r.reachedAt)) continue;
      out.push({ kind: 'refusedLegal', hand: d.hand, turn: d.hostTc, at: r.at, what: `${JSON.stringify(d.action)} refused (${r.code}) while it was legal`, excuses: [...blind], tags });
      break;
    }
    if (!d.replacedBy && d.leftMs > LAST_MOMENT_MS) {
      const dec = t.decisions.get(`${d.hand}:${d.hostTc}`);
      const by = dec?.playedBy;
      // The table's rule may play the very move that was lost (a win is always taken): then nothing was taken.
      if (by && (by.origin === 'table' || (by.origin === 'forged' && by.source === 'auto')) && !sameMove(by.action, d.action)) out.push({ kind: 'droppedForTable', hand: d.hand, turn: d.hostTc, at: d.at, what: `${JSON.stringify(d.action)} lost on the server's side ${(d.leftMs / 1000).toFixed(1)} s before the clock ran out, and the table played its own move`, excuses: ['inFlight', ...blind], tags });
    }
  }
  // A false eviction taken back on the same link, while the table played a decision the phone showed.
  for (const li of t.lines.values()) {
    if (li.evictedAt === null || !li.evictFalse || !li.frameAfterEvict) continue;
    for (const d of t.decisions.values()) {
      const lm = d.playedBy;
      if (!lm || lm.origin !== 'table' || d.playedAt === null || d.playedAt < li.evictedAt) continue;
      if (!d.reached.some((x) => x.line === li.n && x.at <= d.playedAt!)) continue;
      if (lm.ctx.line !== li.n) continue;
      const blocked = t.intents.some((x) => x.hand === d.hand && x.tc === d.tc && !x.sent);
      const excuses: ExceptionName[] = [];
      const tags = blocked ? ['blocked'] : [];
      blindness(t, d.hand, li.evictedAt, li.run, excuses, tags);
      out.push({ kind: 'evictedBack', hand: d.hand, turn: d.tc, at: d.playedAt, what: `the seat said taken away on link ${li.n}, the table played turn ${d.tc}${blocked ? ' (the player was kept from moving)' : ''}, and the server went on with the game on that link`, excuses, tags });
    }
  }
  for (const d of t.doctored) {
    if (evidenceLost(t, d.hand, d.run, d.at) && !blindJudge(t, d.hand, d.at, d.run)) continue;
    const rewound = t.restoredNotices.some((r) => r.hand === d.hand && r.tc < d.tc && r.at > d.at && r.line !== d.line) && (t.lines.get(d.line)?.closedAt ?? Infinity) <= Math.max(...t.restoredNotices.map((r) => r.at));
    const excuses: ExceptionName[] = rewound ? ['serverRewind'] : [];
    const tags: string[] = [];
    // The hand was judged by a later phone that holds no record of what this one was shown.
    blindness(t, d.hand, d.at, d.run, excuses, tags);
    out.push({ kind: 'doctoredView', hand: d.hand, turn: d.tc, at: d.at, what: `a changed view of turn ${d.tc} shown on link ${d.line}`, excuses, tags });
  }
  for (const r of t.repicks) {
    const excuses: ExceptionName[] = t.stoodIn.has(r.hand) ? ['standIn'] : [];
    const tags: string[] = [];
    blindness(t, r.hand, r.at, null, excuses, tags);
    out.push({ kind: 'badSeed', hand: r.hand, turn: -1, at: r.at, what: "the server's share picked again after the phone revealed", excuses, tags });
  }
  return out;
}

// ------------------------------------------------------------------- the properties

/** The known gaps of unit 20f's checks, by what their failures look like. */
export const KNOWN: Record<string, string> = {
  R1: 'recheck 1: a hand dealt with a stand-in share after the link was cut at its commit request, then kept silent and played in the player\'s name: amber, end verified',
  R2: 'recheck 2: a dropped declared win, refused twice naming its turn after the state the player\'s next move made: green',
  R3: 'recheck 3: an eviction notice, then a welcome on the same link, the player kept from moving: green',
  R4: "recheck 4: a dropped claim, another seat's response played first, the player's next move on the next turn: green",
  R5: 'recheck 5: a silent hand on a link the phone revealed its share on again: amber, not red',
  R6: 'recheck 6: an honest table red after an app update (a record saved by the earlier build)',
  R7: 'recheck 7: moves written in the player\'s name while the server froze the table before a Resume from Home: green (root shared with S1)',
  S1: 'sweep 1: after an app restart or a Resume from Home, states held and the hand played in the player\'s name: green',
  S2: "sweep 2: a seat-taken notice, or a welcome saying another device held the seat, then a move written as the player's own: green",
  S3: 'sweep 3: the record kept of a table that left Home missed (another room code, a day, three tables, a stale slot, a false end): a forged hand amber or no verdict, a red hand forgotten',
};

/** Gaps this fuzzer found beyond the nine (named N1, N2, ... in the order found). */
export const FOUND: Record<string, string> = {
  N1: "a hand's states held on a link that was up before the deal (pings answered), then the link ended (cut, or the seat opened on another device) before any frame of the hand came on it: the table's moves for the player amber, the end verified",
  N2: "a hand dealt without asking the connected phone to commit (every frame held back) and played in the player's name, then an app restart: the restored app makes the hand amber, not red, and shows the end verified",
  N3: "the link cut right after the commit request, so the hand is dealt with a stand-in share: the table's own move for the seat 0.3 s into the hand is amber, not red (cut at the reveal or the deal instead: red playedWhileDown)",
  N4: 'honest: two server restarts, one between hands and one during the next deal, fail that hand red (restartedTwice)',
  N5: 'a move lost on the way and played over by the table (amber inFlight) turns green when the app restarts, or the phone resumes after the seat is opened on another device, later in the same hand',
};

function nameOf(v: Omit<Violation, 'known'>, scenario: Scenario, t: Truth): string {
  // The cheats the property failed on (for amber, those no stated limit covers).
  const has = (k: Cheat['kind'], tag?: string) => v.cheats.some((c) => c.kind === k && (!tag || c.tags.includes(tag)));
  const tagged = (tag: string) => v.cheats.some((c) => c.tags.includes(tag));
  if (v.property === 'falseRed') {
    if (scenario.events.some((e) => e.do.a === 'update') && v.detail.includes('auditChanged')) return 'R6';
    if (v.detail.includes('restartedTwice')) return 'N4';
    return 'new';
  }
  if (v.property === 'crash') return 'new';
  const gone = t.goneRoutes.some((r) => r !== 'same');
  if (gone && (v.property === 'redForgotten' || tagged('freshJudge'))) return 'S3';
  if (v.property === 'redForgotten') return 'new';
  if (has('evictedBack')) return 'R3';
  // A refusal that comes after the turn it names was played is taken as the answer to a move the table lost.
  if (has('droppedMove', 'lateRefusals') || has('droppedForTable', 'lateRefusal') || has('droppedForTable', 'lateRefusals')) return 'R2';
  if (has('droppedMove', 'bump')) return 'R4';
  // A deal stood in after the link was cut at its commit request: the table's moves for the seat are not held to the clock.
  if (has('tableEarly', 'stoodIn')) return 'N3';
  // A stand-in notice makes a hand the phone did not watch from its deal one it took part in.
  if (v.property !== 'green' && tagged('stoodIn')) return 'R1';
  if (has('withheldPlay', 'revealedAgain')) return 'R5';
  // A move in flight, played over by the table, shown green.
  if (v.property === 'green' && has('droppedForTable')) return 'N5';
  if (has('withheldPlay', 'linkEnded') || has('tableEarly', 'linkEnded')) return 'N1';
  // Moves for the seat in a hand the phone saw nothing of kept the end from being verified only until the app restarted.
  if (v.property === 'endVerified' && v.cheats.every((c) => c.excuses.some((e) => e === 'missedHand' || e === 'partWay')) && t.appStops.length > 0) return 'N2';
  if (has('forgedPlayer', 'kicked') || has('droppedMove', 'kicked')) return 'S2';
  if (has('forgedPlayer', 'afterRestore') || has('droppedMove', 'afterRestore')) return 'S1';
  if (has('forgedPlayer', 'beforeResume')) return 'R7';
  // The restored-ledger stretch: a move written in the player's name while the app was down, shown green (S1's root).
  if (v.property === 'green' && (has('forgedPlayer', 'appDown') || v.cheats.some((c) => c.excuses.includes('restoredLedger')))) return 'S1';
  return 'new';
}

const statusName = (v: Verdict | undefined) => (!v ? 'none' : v.status === 'ok' ? 'green' : v.status === 'partial' ? 'amber' : v.status === 'failed' ? 'red' : v.status);
const keys = (v: Verdict | undefined) => (v ? [...new Set(v.failures.map((f) => net.failureKey(f) ?? f))].join(',') + (v.caveats.length ? ` C=${v.caveats.map((c) => net.caveatKey(c) ?? c).join(',')}` : '') : '');

export interface Judgement {
  honest: boolean;
  cheats: Cheat[];
  violations: Violation[];
  /** Per hand: the verdict the phone showed last. */
  verdicts: Map<number, Verdict>;
  endVerified: boolean;
  matchFailed: boolean;
}

export function judge(scenario: Scenario, t: Truth): Judgement {
  const honest = isHonest(scenario);
  const cheats = honest ? [] : cheatsOf(t);
  const byHand = new Map<number, Cheat[]>();
  for (const c of cheats) byHand.set(c.hand, [...(byHand.get(c.hand) ?? []), c]);
  const shown = t.runs.filter((r) => r.shown);
  // The table as the player kept it: runs of the client made before the match ended (a later one is a new visit).
  const kept = shown.filter((r) => r.createdAt <= (t.matchOverAt ?? Infinity));
  const last = kept[kept.length - 1]?.shown ?? shown[shown.length - 1]?.shown ?? null;
  const verdicts = new Map<number, Verdict>();
  for (const r of shown) for (const [h, v] of r.shown!.audits) verdicts.set(h, v);
  const endVerified = shown.some((r) => r.shown!.matchOver && r.shown!.matchEndVerified);
  const matchFailed = !!last?.matchFailed;
  const out: Array<Omit<Violation, 'known'>> = [];
  for (const [hand, cs] of byHand) {
    const v = verdicts.get(hand);
    const green = shown.some((r) => r.shown!.audits.get(hand)?.status === 'ok');
    if (green) out.push({ property: 'green', hand, verdict: 'green', cheats: cs, detail: `hand ${hand} shown green` });
    else if (v && v.status !== 'failed') {
      const bare = cs.filter((c) => c.excuses.length === 0);
      if (bare.length) out.push({ property: 'amber', hand, verdict: `${statusName(v)} ${keys(v)}`, cheats: bare, detail: `hand ${hand} ${statusName(v)} with no stated limit for: ${bare.map((c) => c.kind).join(', ')}` });
    } else if (!v && last?.matchOver && cs.some((c) => c.excuses.length === 0)) {
      const onHand = t.runs.some((r) => r.firstShown.has(hand)) || [...t.lines.values()].some((l) => l.committed.has(hand) || l.revealed.has(hand));
      // A match shown failed has warned the player; a server that seated the account under another match id is a stated limit.
      if (onHand && !last.matchFailed && !t.notices.some((n) => n.kind === 'newMatch')) out.push({ property: 'noVerdict', hand, verdict: 'none', cheats: cs, detail: `hand ${hand} has no verdict at the end of the match` });
    }
  }
  // The end may be shown verified only when every cheat of the match is covered by a stated limit the charter does not keep the end unverified for.
  const endBlocking = cheats.filter((c) => c.excuses.length === 0 || c.excuses.every((e) => EXCEPTIONS[e].end === 'unverified'));
  if (endBlocking.length && endVerified) out.push({ property: 'endVerified', hand: null, verdict: 'end verified', cheats: endBlocking, detail: 'the end of a match with a cheated hand shown verified' });
  for (const [hand, fails] of t.redSeen) {
    // A new phone holds nothing of what another phone found (the red hands are kept apart on the phone that found them).
    if (t.runs.some((r) => r.newDevice && r.createdAt > (t.redSeenAt.get(hand) ?? Infinity))) continue;
    // The last run that lists any hand: it must still list this one red, or not list it and show the match failed.
    const listing = [...shown].reverse().find((r) => r.shown!.audits.size > 0)?.shown ?? null;
    const now = listing?.audits.get(hand);
    const forgotten = !listing || (now ? now.status !== 'failed' : !listing.matchFailed);
    if (forgotten && !honest) out.push({ property: 'redForgotten', hand, verdict: statusName(now), cheats: byHand.get(hand) ?? [], detail: `hand ${hand} was shown red (${fails.join(',')}), later ${now ? statusName(now) : 'not listed'}${listing && !listing.matchFailed ? ', and the match not shown failed' : ''}` });
  }
  if (honest) {
    for (const [hand, fails] of t.redSeen) out.push({ property: 'falseRed', hand, verdict: 'red', cheats: [], detail: `honest hand ${hand} red: ${fails.join(',')}` });
    if (t.redSeen.size === 0 && shown.some((r) => r.shown!.matchFailed)) out.push({ property: 'falseRed', hand: null, verdict: 'match failed', cheats: [], detail: 'honest match shown failed' });
  }
  for (const c of t.crashes) out.push({ property: 'crash', hand: null, verdict: '', cheats: [], detail: c });
  const named = out.map((v) => ({ ...v, known: nameOf(v, scenario, t) }));
  // The end shown verified, or a red hand forgotten, shares the root of the hand failures beside it.
  const root = named.find((v) => v.known !== 'new' && v.hand !== null)?.known;
  for (const v of named) if (v.known === 'new' && (v.property === 'endVerified' || v.property === 'noVerdict') && root) v.known = root;
  return { honest, cheats, violations: named, verdicts, endVerified, matchFailed };
}

/** A violation's class: what minimizing keeps (the same property and the same known gap). */
export const classOf = (v: Violation): string => `${v.property}:${v.known}`;


/**
 * The link watch and the clocks (`ClientWatch`, under `TableClient`): what the client measures of the table while it
 * holds a seat. The answers to its pings and the fixed points they give, the host's stamps against this device's clock
 * (`noteStamp`, `refAt`, `watchRefAt`), the watch that drops a link whose stamps fall behind (`watchLink`, run by
 * `TableClient.checkLink`), the stretches in which the app did not run (`ran`), the order frames came in (`noteOrder`)
 * and the states held back behind a welcome (`noteHeld`, `checkLateWelcome`).
 */
import { DRIFT_CAP_MS, DRIFT_RATE, LATE_MS, LINK_PAUSE_MS, MAX_PAUSES, MAX_PONGS, ORDER_SLACK_MS, PAUSE_GRACE_MS, PONG_WINDOW_MS, RAN_GAP_MS, RTT_PUBLISH_MS, SILENT_ANSWER_MS, STEADY_SLACK_MS, WATCH_WINDOW_MS } from './clientclock';
import { isInt, type ClockAnchor, type PlayRecord } from './clientrecords';
import { ClientLedger } from './clientledger';

export abstract class ClientWatch extends ClientLedger {
  /** Ask the table for a `pong` (`TableClient.ping`, client.ts): the watch asks when the stamps fall behind. */
  abstract ping(): void;

  /**
   * The record of the hand on show while it is played (a view, no result yet, the hand not ended), or of the
   * hand whose deal is being agreed (its first turns come right after the deal, and the deal's own fixed point
   * holds the time the table waited for every share); null otherwise.
   */
  protected handOnShow(): PlayRecord | null {
    const v = this.state.view;
    if (v && this.state.lastResult === null && !this.handsEnded.has(v.handNumber)) return this.plays.find((p) => p.hand === v.handNumber) ?? null;
    const h = this.openHand;
    return h !== null && this.state.ceremony !== 'idle' && !this.handsEnded.has(h) ? this.playFor(h) : null;
  }

  /**
   * The table's answer to a ping: a fixed point between its clock and this device's (`ClockAnchor`): it
   * stamped the answer (`now`) after the ping this device sent at `at` reached it, and the answer
   * reached this device at `fat`. Only an answer to a ping this run sent, read in the run of this
   * device's clock it is in now, and only the first answer to each: anything else is ignored. The hand
   * the ping was sent for keeps it while it is still that hand's time (`handOnShow`, `PlayRecord.pongs`),
   * one per `PONG_WINDOW_MS` of ping time (the one with the shortest round trip), and the first of each clock
   * era of the host and run of this device's clock as well: every frame of that scope after it is measured
   * against something (`lateBy`, `unanswered`). Its audit measures every state against them.
   */
  protected notePong(at: unknown, now: unknown): void {
    if (typeof at !== 'number' || !Number.isFinite(at) || typeof now !== 'number' || !Number.isFinite(now)) return;
    const sent = this.pings.get(at);
    if (sent === undefined) return;
    this.pings.delete(at);
    const fat = this.now();
    const seg = sent.seg;
    if (seg !== this.seg() || fat < at) return;
    // (Whatever its stamp says: what it proves about the moves sent before the ping is its place on the link.)
    this.markReached(sent.epoch, sent.out);
    // A fixed point for the first states of links that came with no answer before them (`lateWelcome`).
    this.checkLateWelcome({ at, now, era: this.era, run: this.runId, seg, fat });
    // Nothing on screen reads the round trip: publishing it with every pong would re-render the table and save the record each second.
    if (this.rttAt === null || fat - this.rttAt >= RTT_PUBLISH_MS) {
      this.rttAt = fat;
      this.update({ rttMs: fat - at });
    }
    const play = this.handOnShow();
    if (!play || play.hand !== sent.hand) return;
    const k: ClockAnchor = { at, now, era: this.era, run: this.runId, seg, fat };
    const pongs = (play.pongs ??= []);
    const last = pongs[pongs.length - 1];
    const same = (x: ClockAnchor | undefined): boolean => !!x && x.run === k.run && x.era === k.era && (x.seg ?? 0) === seg;
    // (The first of a scope stays, whatever its round trip: a frame that came before the next one is bound by it alone.)
    if (same(last) && same(pongs[pongs.length - 2]) && Math.floor(last.at / PONG_WINDOW_MS) === Math.floor(at / PONG_WINDOW_MS)) {
      if (fat - at < (last.fat as number) - last.at) pongs[pongs.length - 1] = k;
    } else pongs.push(k);
    if (pongs.length > MAX_PONGS) pongs.splice(0, pongs.length - MAX_PONGS);
  }

  /** The link watch's check at `now` (see `checkLink`). */
  protected watchLink(now: number): 'ok' | 'silent' {
    // The first call, or the first after a pause: the wait starts now.
    const since = this.checkedAt === null ? Number.POSITIVE_INFINITY : now - this.checkedAt;
    const paused = since > LINK_PAUSE_MS;
    this.checkedAt = now;
    if (!this.playing()) {
      this.probedAt = null;
      this.watchFrom = null;
      return 'ok';
    }
    const probeAt = this.probeAt();
    if (paused) {
      this.graceUntil = now + probeAt;
      this.probedAt = null;
      this.watchFrom = null;
      return 'ok';
    }
    if (now < this.graceUntil) return 'ok';
    // A new link is watched from its first stamped frame (a link that brings nothing is the heartbeat's to drop).
    if (!this.linkStamped) {
      this.probedAt = null;
      this.watchFrom = null;
      return 'ok';
    }
    // The watch measures the link from here; a break in its checks starts the stretch again.
    if (this.watchFrom === null || since > RAN_GAP_MS) this.watchFrom = now;
    const ref = this.watchRefAt(now);
    let deficit: number;
    if (this.stampHigh !== null && ref !== null) {
      deficit = now - (this.stampHigh + ref);
      this.waitFrom = null;
    } else {
      // No reference in this scope yet (a new clock era, or this device's clock just jumped): waited for from the first check.
      if (this.waitFrom === null) this.waitFrom = now;
      deficit = now - this.waitFrom;
    }
    if (deficit < probeAt) {
      this.probedAt = null;
      return 'ok';
    }
    if (this.probedAt === null) {
      this.probedAt = now;
      this.ping();
    }
    if (now - this.probedAt < SILENT_ANSWER_MS || deficit < probeAt + SILENT_ANSWER_MS) return 'ok';
    // Frames still come at the pace of their stamps, behind by a delay that holds steady: a network
    // delay that rose in a step and stayed up, which the reference takes in once it has lasted
    // `WATCH_WINDOW_MS`. The link is kept, but measured afresh from the next check: no frame that
    // arrives before then counts as live (`noteStamp`), so none of them can fail a hand as held back.
    if (this.steadyBehind(now)) {
      this.watchFrom = null;
      return 'ok';
    }
    return 'silent';
  }

  /**
   * The link keeps bringing frames at the pace of their stamps, behind by a delay that holds steady:
   * one arrived within a clock-frame period and a second, and the frames of the last `probeAt()`
   * arrived with offsets within `STEADY_SLACK_MS` of one another. Not a link that brings nothing,
   * nor one whose stamps crawl or stand still (each of its frames arrives later after its stamp
   * than the one before it, by the time between them).
   */
  private steadyBehind(now: number): boolean {
    const last = this.lagWin[this.lagWin.length - 1];
    if (!last || now - last.at > this.clockMs + 1_000) return false;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const e of this.lagWin) {
      if (e.at < now - this.probeAt()) continue;
      lo = Math.min(lo, e.lag);
      hi = Math.max(hi, e.lag);
    }
    return hi - lo <= STEADY_SLACK_MS;
  }

  /** This app ran at `t` (a frame, a check, a new link, a move): a gap of more than `RAN_GAP_MS` since it last ran was a pause. */
  protected ran(t: number): void {
    if (this.ranAt !== null && t - this.ranAt > RAN_GAP_MS) {
      this.pause = { from: this.ranAt, to: t };
      this.pauses.push(this.pause);
      if (this.pauses.length > MAX_PAUSES) this.pauses.shift();
    }
    this.ranAt = t;
  }

  /** How far the host's stamps may fall behind this device's clock before the watch asks for a `pong`: `2 × CLOCK_FRAME_MS + 2 s`, or less when the welcome announced a shorter clock-frame period. */
  private probeAt(): number {
    return 2 * this.clockMs + 2_000;
  }

  /** `t` falls within `PAUSE_GRACE_MS` after a pause: a frame handled then may have waited in the device through it. */
  protected afterPause(t: number): boolean {
    return this.pause !== null && t - this.pause.to <= PAUSE_GRACE_MS;
  }

  /** The link in use has brought a state: only then are its clock frames and pongs believed. */
  protected stateHere(): boolean {
    return this.linkShown !== null && this.linkShown.epoch === this.epoch;
  }

  /**
   * This device holds a seat on a link that is up: one it has not left, that has not closed, and on which its seat
   * was not opened on another device. Not whether the table has welcomed it there (`connected`): an honest host
   * welcomes a link before it sends anything else on it, so a table that sends frames on a link it never welcomed
   * is measured as on any other (`linkOpen`).
   */
  protected holdsSeat(): boolean {
    return this.state.seat !== null && !this.state.kicked && this.linkOpen && this.evictedOn !== this.epoch;
  }

  /** A hand is being played at this seat over a link that is up (`holdsSeat`). */
  private playing(): boolean {
    const st = this.state;
    return this.holdsSeat() && !st.matchOver && st.view !== null && st.lastResult === null && st.ceremony === 'idle';
  }

  /** The least arrival offset of this clock era and run of this device's clock at `t`, allowing for drift since it was seen, at most `DRIFT_CAP_MS` (null: none yet). */
  protected refAt(t: number): number | null {
    const r = this.lagRef;
    if (!r || r.era !== this.era || r.seg !== this.seg()) return null;
    return r.lag + Math.min(DRIFT_CAP_MS, DRIFT_RATE * Math.max(0, t - r.at));
  }

  /**
   * The link watch's reference at `t`: the least arrival offset of the frames of this scope that
   * arrived in the `WATCH_WINDOW_MS` before it (or of the last one, when none did), never less than
   * `refAt(t)`; null while the scope has no reference. A network delay that rose and stayed up is in
   * it once it has lasted that long; stamps that crawl are not, before the watch drops the link.
   */
  private watchRefAt(t: number): number | null {
    const ref = this.refAt(t);
    if (ref === null) return null;
    let low = Number.POSITIVE_INFINITY;
    for (const e of this.lagWin) if (e.at >= t - WATCH_WINDOW_MS) low = Math.min(low, e.lag);
    const last = this.lagWin[this.lagWin.length - 1];
    if (low === Number.POSITIVE_INFINITY && last) low = last.lag;
    return low === Number.POSITIVE_INFINITY ? ref : Math.max(ref, low);
  }

  /** Keep the arrival offset `lag` of a frame that arrived at `at` for the watch's reference (one entry a second, the least). */
  private noteLag(at: number, lag: number): void {
    const last = this.lagWin[this.lagWin.length - 1];
    if (last && at - last.from < 1_000) {
      last.at = at;
      last.lag = Math.min(last.lag, lag);
    } else this.lagWin.push({ from: at, at, lag });
    while (this.lagWin.length > 1 && this.lagWin[0].at < at - WATCH_WINDOW_MS) this.lagWin.shift();
  }

  /**
   * Note the stamp `now` of a frame (a state, a hand's end, a clock frame or a pong): what it says of
   * the host's clock against this device's. A frame that arrived with the least offset yet seen in
   * its scope becomes the reference (`lagRef`); every frame's offset feeds the watch's reference
   * (`watchRefAt`), and the highest stamp the watch's deficit (`checkLink`).
   * Returns when the frame arrived, the earliest it can have arrived (`atLo`), the reference before
   * it (`ref`, null while the scope has none) and the watch's (`wref`), whether its link was working
   * (it had brought a state or a hand's end stamped not more than `LATE_MS` late against `ref`: a
   * clock frame or a pong vouches for no state, so it never makes a link working; `opens` says the
   * frame is one that can) and whether it was live:
   * working, while a hand is played, with the watch checking it within the last `RAN_GAP_MS`, not just
   * after a pause and not in the watch's grace after one, and measured by the watch without a break
   * since before it was `2 × CLOCK_FRAME_MS + 2 s` late against `wref`. No honest frame on a live link
   * is more than `LATE_MS` late against `wref`: the watch drops a link before its stamps fall that far
   * behind.
   */
  protected noteStamp(now: unknown, opens = false): { at: number; atLo: number; ref: number | null; wref: number | null; live: boolean; working: boolean; seg: number } | null {
    if (typeof now !== 'number' || !Number.isFinite(now)) return null;
    const at = this.now();
    const seg = this.seg();
    if (!this.lagRef || this.lagRef.era !== this.era || this.lagRef.seg !== seg) {
      if (this.lagRef) this.waitFrom = null;
      this.lagRef = null;
      this.stampHigh = null;
      this.lagWin = [];
    }
    const atLo = Math.min(at, this.frameAtLo ?? at);
    const ref = this.refAt(atLo);
    const wref = this.watchRefAt(atLo);
    const working = this.workingEpoch === this.epoch;
    const excess = ref === null ? 0 : atLo - now - ref;
    // Live: the watch was measuring this link, and had been since before the frame was `probeAt` late
    // by its reference, so it would have dropped the link before an honest frame was later than `LATE_MS`.
    const late = wref === null ? 0 : atLo - now - wref;
    const watched = this.watchFrom !== null && late <= at - this.watchFrom + this.probeAt();
    const live = working && watched && this.playing() && this.checkedAt !== null && at - this.checkedAt <= RAN_GAP_MS && !this.afterPause(at) && at >= this.graceUntil;
    const lag = at - now;
    const cur = this.refAt(at);
    if (cur === null || lag <= cur) this.lagRef = { lag, at, era: this.era, seg };
    if (!this.afterPause(at)) this.noteLag(at, lag);
    if (this.stampHigh === null || now > this.stampHigh) this.stampHigh = now;
    this.linkStamped = true;
    if (opens && excess <= LATE_MS) this.workingEpoch = this.epoch;
    return { at, atLo, ref, wref, live, working, seg };
  }

  /**
   * The deal of hand `h` as a fixed point between the two clocks, when this device revealed its share in
   * the attempt that was dealt and the hand's first frame came after it, over the same link: the host
   * cannot have dealt from that share before this device sent it. (The audit also holds the deal to the
   * share it revealed: a deal without it fails, `runAudit`.) Null otherwise.
   */
  protected dealFixed(h: number): ClockAnchor | null {
    if (this.commitHand !== h || this.standInHand === h || !this.secret) return null;
    const last = this.recordFor(h)?.attempts.slice(-1)[0];
    const first = this.plays.find((p) => p.hand === h)?.seen[0];
    // (Not from a state restored damaged: its stamp may be anything, `cleanSeen`.)
    if (!last?.revealed || typeof last.revealedAt !== 'number' || !first || first.kept === false || typeof first.now !== 'number' || first.epoch !== last.revealedEpoch || first.at < last.revealedAt) return null;
    return { at: last.revealedAt, now: first.now, era: first.era ?? 0, run: last.revealedRun, seg: last.revealedSeg, fat: first.at };
  }

  /**
   * One WebSocket is one ordered stream, and an honest host's stamps never go back (`TableHost.stamp`),
   * so its frames arrive in the order of their stamps. A frame of hand `hand` at turn `tc` that
   * arrives after one stamped later than it (beyond `ORDER_SLACK_MS`) was held back by the host:
   * this is what catches a state held back while the stamps of the frames sent past it run slow, a
   * delay the watch's reference may take in (`watchRefAt`). It only keeps the order: it does not feed
   * the link watch, which measures the stamps against this device's clock instead (`noteStamp`,
   * `checkLink`), so a stamp that moves on by a millisecond does not count as hearing from the table.
   * Every stamped frame of the link counts, the answers to this device's pings included, from the link's first frame:
   * so a hand's state held back while the table answers the pings (its deal's, while this device waits for the deal
   * after revealing its share, included) arrives behind them. Returns whether this frame did.
   */
  protected noteOrder(now: unknown, hand: number | null, tc: number | null): boolean {
    if (typeof now !== 'number' || !Number.isFinite(now)) return false;
    const last = this.linkStamp;
    const same = last !== null && last.epoch === this.epoch && last.era === this.era;
    const behind = same && now < last.now - ORDER_SLACK_MS && hand !== null && tc !== null && isInt(tc);
    if (behind) this.noteHeld(hand, tc);
    if (!same || now > last.now) this.linkStamp = { epoch: this.epoch, era: this.era, now };
    return behind;
  }

  /** The host held back the state of turn `tc` of hand `hand` (or of an earlier turn already noted). */
  protected noteHeld(hand: number, tc: number): void {
    if (this.handsEnded.has(hand)) return;
    const play = this.playFor(hand);
    play.held = Math.min(play.held ?? Number.POSITIVE_INFINITY, tc);
  }

  /**
   * A link's first state that came with no answer to a ping before it (`lateWelcome`), against a fixed point between the
   * two clocks (`k`, an answer to a ping sent since that link's join, in the same clock era and run of this device's
   * clock): the host stamped the answer after the ping left, so the state it stamped `stamp` left it no earlier than
   * `stamp - k.now + k.at` on this device's clock, less the drift the two clocks may show between the two stamps. An honest
   * host sends that state right behind the welcome, on a steady clock, so it left before the welcome came, whatever the
   * network did to either: one the host itself puts more than `LATE_MS` after the welcome came was held back (`noteHeld`).
   * (Only pings sent since the join: a clock the server moved on before it, as in a drop, is judged by the other checks.)
   */
  private checkLateWelcome(k: ClockAnchor): void {
    if (k.run !== this.runId) return;
    for (const x of [...this.lateWelcome]) {
      if (this.handsEnded.has(x.hand)) {
        this.lateWelcome.splice(this.lateWelcome.indexOf(x), 1);
        continue;
      }
      if (k.era !== x.era || (k.seg ?? 0) !== x.seg || k.at < x.after) continue;
      const left = x.stamp - k.now + k.at - DRIFT_RATE * Math.abs(x.stamp - k.now);
      if (left - x.welcomeAt <= LATE_MS) continue;
      this.lateWelcome.splice(this.lateWelcome.indexOf(x), 1);
      this.noteHeld(x.hand, x.from);
    }
  }
}

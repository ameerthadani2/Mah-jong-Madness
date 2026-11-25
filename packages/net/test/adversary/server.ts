/**
 * The server between the honest host and the player's phone, programmed by a scenario: each event waits for its moment
 * (`Anchor`), then acts on the frames to the phone, the messages from it, the host's log, the phone's app or the network
 * for as long as it lasts, and its start and end are moments other events can wait for. Everything it does of its own
 * making is told to the ground truth (a false notice is marked false; a frame it changed is marked changed), so that
 * the oracle knows what the phone could not.
 */
import type { Action, GameState } from '@mjm/engine';
import type { ClientMessage, HostMessage } from '../../src/index';
import { net, oldNet } from './load';
import { hashOf } from './random';
import type { Act, Anchor, Event, MoveKind, Scenario } from './scenario';
import { App, forgedMove, moveKind, RECONNECT_MS, type Adversary, type Line, type Moment, type Sim } from './sim';
import type { DroppedMove } from './truth';

const HOUR = 3_600_000;

type Status = 'armed' | 'pending' | 'active' | 'done';

interface Running {
  i: number;
  e: Event;
  status: Status;
  startAt: number;
  /** The frame or message the event was set on, when it began at its moment. */
  trigger: HostMessage | ClientMessage | null;
  /** The hand on the table when it began. */
  hand: number;
  /** Per-act working state. */
  s: Record<string, unknown>;
}

const isState = (m: HostMessage): m is Extract<HostMessage, { t: 'state' }> => m.t === 'state';
const handOfFrame = (m: HostMessage): number | null => (m.t === 'state' ? m.view.handNumber : m.t === 'clock' ? m.hand : m.t === 'hand_over' || m.t === 'hand_missed' ? m.audit.handNumber : null);

function matchesMove(kind: MoveKind, a: Action | undefined): boolean {
  return kind === 'any' || moveKind(a) === kind;
}

/** Another tile of a different kind than `t`, for a changed view of the player's hand. */
const otherTile = (t: number): number => (t + 4 * 9) % 136;

export class Server implements Adversary {
  private readonly ev: Running[];
  private evicted: { line: number; r: Running } | null = null;
  /** The ping the app sends right behind its next join does not reach the table (`cut` with `noPing`). */
  private swallowPing = false;
  constructor(
    private readonly sim: Sim,
    readonly scenario: Scenario,
  ) {
    this.ev = scenario.events.map((e, i) => ({ i, e, status: 'armed' as Status, startAt: 0, trigger: null, hand: -1, s: {} }));
  }

  private get now(): number {
    return this.sim.clock.now;
  }
  private get line(): Line | null {
    return this.sim.phone.line;
  }
  private active(a?: Act['a']): Running[] {
    return this.ev.filter((r) => r.status === 'active' && (!a || r.e.do.a === a));
  }

  // --------------------------------------------------------------- when events begin and end

  private anchorMatches(at: Anchor, mo: Moment): boolean {
    if (at.on === 'after' || at.on !== mo.on) return false;
    if (at.hand !== mo.hand) return false;
    if (at.on === 'state' && mo.on === 'state') return at.kind === mo.kind && at.k === mo.k;
    if (at.on === 'move' && mo.on === 'move') return at.kind === mo.kind && at.k === mo.k;
    return true;
  }

  moment(mo: Moment, line: Line | null, frame: HostMessage | ClientMessage | null): void {
    for (const r of this.ev) {
      if (r.status !== 'armed' || !this.anchorMatches(r.e.at, mo)) continue;
      const ms = r.e.at.ms ?? 0;
      if (ms > 0) {
        r.status = 'pending';
        r.startAt = this.now + ms;
      } else this.begin(r, frame, line, mo.on === 'move' || mo.on === 'reveal' ? 'up' : 'down');
    }
  }

  private edge(i: number, edge: 'start' | 'end'): void {
    for (const r of this.ev) {
      const at = r.e.at;
      if (r.status !== 'armed' || at.on !== 'after' || at.event !== i || at.edge !== edge) continue;
      const ms = at.ms ?? 0;
      if (ms > 0) {
        r.status = 'pending';
        r.startAt = this.now + ms;
      } else this.begin(r, null, this.line, null);
    }
  }

  /** The hand on the table, or the next one between hands. */
  private handNow(): number {
    const h = this.sim.hostInside();
    if (h.phase === 'playing' && h.game) return h.game.handNumber;
    if (h.phase === 'hand_over' && h.game) return h.game.handNumber + 1;
    return h.snapshot.handNumber;
  }

  private begin(r: Running, trigger: HostMessage | ClientMessage | null, line: Line | null, dir: 'down' | 'up' | null): void {
    r.status = 'active';
    r.trigger = trigger;
    r.s.dir = dir;
    r.hand = this.handNow();
    this.sim.truth.note(`e${r.i} ${r.e.do.a} begins`);
    this.start(r, line);
    this.edge(r.i, 'start');
  }

  private end(r: Running): void {
    if (r.status === 'done') return;
    r.status = 'done';
    this.sim.truth.note(`e${r.i} ${r.e.do.a} ends`);
    this.edge(r.i, 'end');
  }

  // --------------------------------------------------------------- what each act does when it begins

  private start(r: Running, line: Line | null): void {
    const sim = this.sim;
    const phone = sim.phone;
    const act = r.e.do;
    switch (act.a) {
      case 'cut':
        // `lose`: the frame the cut was set on goes with the link; otherwise the link breaks right after it reaches the
        // phone (a frame to the phone) or the table (a message from it).
        if (act.lose && line) this.cut(r);
        else {
          r.s.cutAt = this.now + (r.s.dir === 'down' ? 1_000 : 1);
          if (r.s.dir === 'down') r.s.cutAfter = r.trigger;
        }
        return;
      case 'latency':
      case 'stall':
      case 'pingLoss':
      case 'drop':
        r.s.until = this.now + act.forMs;
        return;
      case 'dup':
      case 'reorder':
      case 'doctor':
      case 'dropMove':
      case 'withholdRecord':
      case 'repick':
        return;
      case 'withhold':
        r.s.until = typeof act.forMs === 'number' ? this.now + act.forMs : Infinity;
        r.s.held = [] as HostMessage[];
        return;
      case 'seatTaken':
        if (line && line.open) {
          line.send({ t: 'disconnected' });
          sim.truth.notice('seatTaken', line, true);
        }
        phone.resumeAt = this.now + act.resumeMs;
        r.s.resumeAt = phone.resumeAt;
        return;
      case 'elsewhere':
        r.s.pending = true;
        phone.lose(act.downMs, { host: true });
        return;
      case 'evicted':
        if (!line || !line.open) return this.end(r);
        r.s.line = line.n;
        this.evicted = { line: line.n, r };
        // Right behind the frame it was set on (or at once).
        if (r.s.dir !== 'down') {
          line.send({ t: 'error', code: 'evicted', message: 'You were removed from this table.' });
          sim.truth.notice('evicted', line, true);
        } else r.s.behind = true;
        r.s.decision = r.trigger && 't' in r.trigger && r.trigger.t === 'state' ? r.trigger.view.turnCounter : (sim.host.game?.turnCounter ?? null);
        return;
      case 'restored': {
        const g = sim.host.game;
        if (line && line.open) {
          const hand = g?.handNumber ?? sim.hostInside().snapshot.handNumber;
          const tc = g ? Math.max(0, g.turnCounter - act.back) : -1;
          line.send({ t: 'restored', handNumber: hand, turnCounter: tc });
          sim.truth.notice('restored', line, true, hand);
        }
        return this.end(r);
      }
      case 'standIn':
        if (line && line.open) {
          const hand = sim.hostInside().snapshot.handNumber;
          line.send({ t: 'stand_in', handNumber: hand, attempt: sim.hostInside().ceremonyAttempts });
          sim.truth.notice('standIn', line, true, hand);
        }
        return this.end(r);
      case 'forge':
        r.s.count = 0;
        r.s.done = new Set<string>();
        return;
      case 'newMatch':
        r.s.pending = true;
        return;
      case 'restart':
        phone.stop();
        phone.startAt = this.now + act.downMs;
        r.s.until = phone.startAt;
        return;
      case 'update':
        if (!oldNet) return this.end(r);
        phone.stop();
        sim.pendingBuild = net;
        phone.startAt = this.now + act.downMs;
        r.s.until = phone.startAt;
        return;
      case 'resume':
        phone.resumeAt = this.now + act.afterMs;
        r.s.until = phone.resumeAt;
        return;
      case 'saveFails':
        phone.app.failing = true;
        return this.end(r);
      case 'fresh':
        // The account is seated again on another phone: nothing of this one's record goes with it.
        phone.leave();
        phone.app = new App(phone);
        sim.truth.freshPhones++;
        phone.reseatAt = this.now + act.afterMs;
        phone.reseatRoom = sim.room;
        r.s.until = phone.reseatAt;
        return;
      case 'gone':
        return this.gone(r, act.route, act.reseatMs);
      case 'otherDevice':
        sim.otherDevice(act.forMs);
        r.s.until = this.now + act.forMs;
        return;
      case 'serverRestart':
        sim.restartServer(act.downMs);
        r.s.until = this.now + act.downMs;
        return;
      case 'sleep':
        phone.asleep = true;
        r.s.until = this.now + act.forMs;
        return;
    }
  }

  private cut(r: Running): void {
    const act = r.e.do as Extract<Act, { a: 'cut' }>;
    this.sim.phone.lose(act.downMs, { host: !act.half });
    r.s.until = this.now + act.downMs;
  }

  /** The table is said to be gone, then the account is seated there again (by the route's way to the app's records). */
  private gone(r: Running, route: string, reseatMs: number): void {
    const sim = this.sim;
    const phone = sim.phone;
    sim.truth.goneRoutes.push(route);
    phone.reseatRoom = route === 'moved' ? `${sim.room}Y` : sim.room;
    if (route === 'stale') {
      // The app is closed with the table in its saved slot and opened 13 h later: the launch deletes the stale record.
      phone.stop();
      sim.appClockSkew += 13 * HOUR;
      phone.reseatAt = this.now + reseatMs;
      r.s.until = phone.reseatAt;
      return;
    }
    if (route === 'fakeEnd') {
      // On the next rejoin, right behind the welcome, the match is over; once the phone took it, the link goes.
      r.s.fakeEnd = 1;
      phone.lose(RECONNECT_MS, { host: true });
      return;
    }
    // room_unavailable on the session's reconnect: the record leaves the slot into the archive.
    phone.gone = true;
    phone.lose(RECONNECT_MS, { host: true });
    r.s.reseatMs = reseatMs;
    r.s.route = route;
  }

  // --------------------------------------------------------------- every step

  tick(): void {
    const sim = this.sim;
    const phone = sim.phone;
    for (const r of this.ev) if (r.status === 'pending' && this.now >= r.startAt) this.begin(r, null, this.line, null);
    for (const r of this.active()) {
      const act = r.e.do;
      switch (act.a) {
        case 'cut':
          if (typeof r.s.cutAt === 'number' && this.now >= r.s.cutAt) {
            delete r.s.cutAt;
            this.cut(r);
          }
          break;
        case 'latency':
        case 'stall':
        case 'pingLoss':
        case 'drop':
          if (this.now >= (r.s.until as number)) {
            if (act.a === 'stall') for (const l of sim.lines) l.release();
            this.end(r);
          }
          break;
        case 'withhold':
          if (this.now >= (r.s.until as number) || (sim.hostInside().phase !== 'playing' && typeof act.forMs === 'number')) this.releaseWithhold(r);
          break;
        case 'elsewhere':
          if (r.s.pending === 'welcomed' && phone.client?.state.kicked && phone.resumeAt === null && !r.s.resume) {
            phone.resumeAt = this.now + act.resumeMs;
            r.s.resume = true;
          }
          break;
        case 'evicted':
          this.evictTick(r);
          break;
        case 'forge':
          this.forgeTick(r);
          break;
        case 'gone':
          this.goneTick(r);
          break;
        case 'sleep':
          if (this.now >= (r.s.until as number)) {
            phone.asleep = false;
            if (act.mono === 'stops') phone.monoOffset -= act.forMs;
            this.end(r);
          }
          break;
        default:
          break;
      }
    }
  }

  /** The phone joins on a new link: the events that last until then end (and those waiting on their end begin, before the join). */
  newLine(kind: 'reconnect' | 'run'): void {
    for (const r of this.active()) {
      const a = r.e.do.a;
      if (a === 'withhold' && (r.e.do as Extract<Act, { a: 'withhold' }>).forMs === 'line') this.releaseWithhold(r);
      else if (a === 'cut' && r.s.cutAt === undefined) {
        if ((r.e.do as Extract<Act, { a: 'cut' }>).noPing) this.swallowPing = true;
        this.end(r);
      }
      else if (a === 'serverRestart') this.end(r);
      else if (kind === 'run' && (a === 'seatTaken' || a === 'elsewhere' || a === 'resume' || a === 'restart' || a === 'update' || a === 'fresh' || a === 'otherDevice')) this.end(r);
      else if (kind === 'run' && a === 'gone' && (r.s.reseatPlanned || r.s.fakeEnd === 3 || (r.e.do as Extract<Act, { a: 'gone' }>).route === 'stale')) this.end(r);
    }
  }

  private releaseWithhold(r: Running): void {
    const act = r.e.do as Extract<Act, { a: 'withhold' }>;
    const line = this.line;
    if (line && line.open) {
      if (act.release === 'held') for (const m of r.s.held as HostMessage[]) line.send(m);
      if (act.release === 'fresh' && this.sim.hostInside().phase === 'playing' && this.sim.host.game) line.send(this.sim.hostInside().stateMsg(0));
    }
    this.end(r);
  }

  private evictTick(r: Running): void {
    const act = r.e.do as Extract<Act, { a: 'evicted' }>;
    if (r.s.back || act.back === 'none') return;
    const sim = this.sim;
    const g = sim.host.game;
    const tc = r.s.decision as number | null;
    const tableMoved = act.back === 'afterTable' ? !!g && tc !== null && (g.handNumber !== r.hand || g.actionLog.some((e) => e.seat === 0 && e.n >= tc)) : false;
    const due = typeof act.back === 'number' ? this.now >= r.startAt + act.back : tableMoved || sim.hostInside().phase !== 'playing';
    if (!due) return;
    r.s.back = true;
    this.evicted = null;
    const line = sim.lines.find((l) => l.n === r.s.line);
    if (!line || !line.open) return this.end(r);
    // The host's own welcome for the seat, on the same link, then the table as it stands.
    const h = sim.hostInside();
    line.send({ t: 'welcome', seat: 0, roomCode: h.roomCode, rules: h.rules, seats: h.seatInfo() as never, matchId: h.matchId, token: h.seats[0].token ?? '', botSkill: h.botSkill as never, clockMs: 3_000 });
    if (h.phase === 'playing' && sim.host.game) line.send(h.stateMsg(0));
    this.end(r);
  }

  private forgeTick(r: Running): void {
    const act = r.e.do as Extract<Act, { a: 'forge' }>;
    const sim = this.sim;
    const g = sim.host.game;
    const playing = sim.hostInside().phase === 'playing' && !!g;
    if (act.n === 'hand' && (!playing || g!.handNumber !== r.hand) && (r.s.count as number) > 0) return this.end(r);
    if (!playing || !g) return;
    if (act.n === 'hand' && g.handNumber !== r.hand) return;
    const d = sim.truth.currentDecision();
    if (!d || d.hand !== g.handNumber) return;
    const done = r.s.done as Set<string>;
    if (done.has(d.key) || this.now - d.startedAt < act.delayMs) return;
    const mv = forgedMove(sim, g, act.policy);
    if (!mv) return;
    done.add(d.key);
    if (sim.forge(mv, act.label)) {
      r.s.count = (r.s.count as number) + 1;
      sim.truth.note(`e${r.i} forged ${JSON.stringify(mv)} as ${act.label} at hand ${g.handNumber} turn ${g.turnCounter}`);
    }
    if (typeof act.n === 'number' && (r.s.count as number) >= act.n) this.end(r);
  }

  private goneTick(r: Running): void {
    const sim = this.sim;
    const phone = sim.phone;
    const act = r.e.do as Extract<Act, { a: 'gone' }>;
    if (act.route === 'fakeEnd') {
      if (r.s.fakeEnd === 2 && phone.client?.state.matchOver) {
        r.s.fakeEnd = 3;
        sim.truth.notice('fakeEnd', phone.line, true);
        // The app has cleared the saved table (a match that is over is not kept); the server drops the link.
        phone.app.tick();
        phone.app.save();
        phone.leave();
        phone.reseatAt = this.now + act.reseatMs;
      }
      return;
    }
    if (act.route === 'stale') return;
    // The reconnect was answered room_unavailable (the app took the table off Home); then the account is seated again.
    if (!r.s.reseatPlanned && phone.gone === true && phone.client === null) {
      r.s.reseatPlanned = true;
      if (act.route === 'expired') sim.appClockSkew += 25 * HOUR;
      if (act.route === 'pushed') {
        // Three other tables leave Home after it, each with a record of its own.
        const app = phone.app;
        const base = app.slot;
        for (let k = 1; k <= 3; k++) {
          const other = JSON.parse(JSON.stringify(app.archive[app.archive.length - 1]?.client ?? base?.client ?? null));
          if (!other?.state) continue;
          other.state.matchId = `m-other-${k}`;
          other.state.roomCode = `OTHER${k}`;
          app.slot = { kind: 'online', signalUrl: 'wss://game.example/ws', roomCode: `OTHER${k}`, token: 'tok', client: other, savedAt: app.now() };
          sim.appClockSkew += 60_000;
          app.put(null);
        }
      }
      phone.reseatAt = this.now + (r.s.reseatMs as number);
    }
  }

  // --------------------------------------------------------------- frames to the phone

  welcome(line: Line, m: Extract<HostMessage, { t: 'welcome' }>): HostMessage[] {
    let out: HostMessage = m;
    for (const r of this.active('newMatch')) {
      if (!r.s.pending) continue;
      r.s.pending = false;
      out = { ...out, matchId: `${m.matchId}-x` };
      this.sim.truth.notice('newMatch', line, true);
      this.end(r);
    }
    for (const r of this.active('elsewhere')) {
      if (r.s.pending !== true) continue;
      r.s.pending = 'welcomed';
      out = { ...out, elsewhere: true };
      this.sim.truth.notice('elsewhere', line, true);
    }
    const extra: HostMessage[] = [];
    for (const r of this.active('gone')) {
      if (r.s.fakeEnd !== 1) continue;
      r.s.fakeEnd = 2;
      const v = this.sim.phone.client?.state.view;
      if (v) extra.push({ t: 'match_over', scores: v.scores.slice(), view: v });
    }
    return [out, ...extra];
  }

  down(line: Line, m0: HostMessage): HostMessage[] {
    let frames: HostMessage[] = [m0];
    // A frame on a link the server took the seat away on goes nowhere (until it takes the eviction back).
    if (this.evicted && this.evicted.line === line.n) {
      const r = this.evicted.r;
      if (r.s.behind && this.isTrigger(r, m0)) {
        r.s.behind = false;
        this.sim.truth.notice('evicted', line, true);
        return [m0, { t: 'error', code: 'evicted', message: 'You were removed from this table.' }];
      }
      return [];
    }
    for (const r of this.active()) {
      const act = r.e.do;
      const next: HostMessage[] = [];
      for (const m of frames) {
        switch (act.a) {
          case 'pingLoss':
            if (m.t === 'pong' && hashOf(this.scenario.seed, 'pong', m.at) % 1000 < act.rate * 1000) continue;
            next.push(m);
            break;
          case 'drop':
            if (act.what === 'any' || m.t === act.what) continue;
            next.push(m);
            break;
          case 'dup':
            next.push(m);
            if (isState(m) && (r.s.n as number | undefined ?? 0) < act.n) {
              r.s.n = ((r.s.n as number | undefined) ?? 0) + 1;
              next.push({ ...m });
              if ((r.s.n as number) >= act.n) this.end(r);
            }
            break;
          case 'reorder':
            if (r.s.first === undefined) {
              r.s.first = m;
              break;
            }
            next.push(m, r.s.first as HostMessage);
            this.end(r);
            break;
          case 'withhold': {
            const h = handOfFrame(m);
            // The hand's result ends it (the held frames go first, when they are let go).
            if ((m.t === 'hand_over' || m.t === 'hand_missed') && h === r.hand) {
              this.releaseWithhold(r);
              next.push(m);
              break;
            }
            const keep = act.what === 'all' ? m.t !== 'welcome' && m.t !== 'lobby' : (m.t === 'state' || m.t === 'clock') && h === r.hand;
            if (keep) {
              (r.s.held as HostMessage[]).push(m);
              continue;
            }
            next.push(m);
            break;
          }
          case 'doctor':
            if (isState(m) && ((r.s.n as number | undefined) ?? 0) < act.n) {
              const d = this.doctor(m, act.field);
              if (d) {
                r.s.n = ((r.s.n as number | undefined) ?? 0) + 1;
                this.sim.doctoredFrames.add(d);
                next.push(d);
                if ((r.s.n as number) >= act.n) this.end(r);
                break;
              }
            }
            next.push(m);
            break;
          case 'withholdRecord':
            if ((m.t === 'hand_over' || m.t === 'hand_missed') && m.audit.handNumber === r.hand) {
              this.end(r);
              continue;
            }
            next.push(m);
            break;
          case 'seatTaken':
            // While the player is away from the seat the server says nothing more on that link.
            next.push(m);
            break;
          default:
            next.push(m);
        }
      }
      frames = next;
    }
    return frames;
  }

  private isTrigger(r: Running, m: HostMessage): boolean {
    const t = r.trigger as HostMessage | null;
    if (!t) return false;
    if (t.t === 'state' && m.t === 'state') return t.view.handNumber === m.view.handNumber && t.view.turnCounter === m.view.turnCounter;
    return t.t === m.t;
  }

  /** A changed copy of a state, its hash kept, or null when the change would show nothing. */
  private doctor(m: Extract<HostMessage, { t: 'state' }>, field: string): HostMessage | null {
    const v = JSON.parse(JSON.stringify(m.view)) as typeof m.view;
    if (field === 'scores') v.scores = v.scores.map((s: number, i: number) => (i === 1 ? s + 8 : s));
    else if (field === 'tile') {
      const hand = v.players[0]?.hand;
      if (!hand || hand.length === 0) return null;
      hand[0] = otherTile(hand[0]);
    } else if (field === 'offer') {
      const offers = (v.pending as { offers?: unknown[] } | undefined)?.offers;
      if (!offers || offers.length === 0) return null;
      (v.pending as { offers: unknown[] }).offers = [];
    } else if (field === 'drawn') {
      if (typeof v.lastDrawn !== 'number') return null;
      v.lastDrawn = otherTile(v.lastDrawn);
    }
    return { ...m, view: v };
  }

  hold(_line: Line, _m: HostMessage): boolean {
    return this.active('stall').length > 0;
  }

  delay(_line: Line, _m: HostMessage): number {
    return this.active('latency').reduce((s, r) => s + (r.e.do as Extract<Act, { a: 'latency' }>).ms, 0);
  }

  delivered(line: Line, m: HostMessage): void {
    for (const r of this.active('cut')) {
      if (r.s.cutAfter !== m || r.s.cutAt === undefined) continue;
      delete r.s.cutAt;
      delete r.s.cutAfter;
      this.cut(r);
      return;
    }
    // Late refusals of a dropped move: right after the next state reaches the phone.
    if (m.t === 'state') {
      for (const r of this.active('dropMove')) {
        const d = r.s.dropped as DroppedMove | undefined;
        const act = r.e.do as Extract<Act, { a: 'dropMove' }>;
        if (!d || r.s.refused || act.refuse !== 'afterState' || d.line !== line.n) continue;
        if (m.view.handNumber !== d.hand || m.view.turnCounter <= d.hostTc) continue;
        r.s.refused = true;
        this.refuse(line, d, act, true);
        this.end(r);
      }
    }
  }

  private refuse(line: Line, d: DroppedMove, act: Extract<Act, { a: 'dropMove' }>, late: boolean): void {
    const turn = act.turn === 'none' ? null : act.turn === 'before' ? (d.msgTc ?? d.hostTc) - 1 : (d.msgTc ?? d.hostTc);
    for (let k = 0; k < Math.max(1, act.times); k++) {
      const m = (turn === null ? { t: 'error', code: act.code, message: 'That move is not allowed now.' } : { t: 'error', code: act.code, message: 'That move is not allowed now.', turnCounter: turn }) as HostMessage;
      this.sim.truth.refusal(d, act.code, turn, late, m);
      if (late) line.inject(m);
      else line.send(m);
    }
  }

  // --------------------------------------------------------------- messages from the phone

  up(line: Line, m: ClientMessage): boolean {
    const sim = this.sim;
    if (m.t === 'ping' && this.swallowPing) {
      this.swallowPing = false;
      return false;
    }
    for (const r of this.active()) {
      const act = r.e.do;
      if (act.a === 'dropMove' && m.t === 'action' && !r.s.dropped && matchesMove(act.kind, m.action) && (!act.contested || this.contested())) {
        // Lost on the server's side: the table never sees it.
        sim.truth.droppedUp(line, m);
        const d = sim.truth.lastDropped()!;
        r.s.dropped = d;
        if (act.busy) line.send({ t: 'error', code: 'busy', message: 'The table is busy.' });
        if (act.refuse === 'now') {
          this.refuse(line, d, act, false);
          this.end(r);
        } else if (act.refuse === 'none') this.end(r);
        sim.truth.note(`e${r.i} dropped ${JSON.stringify(m.action)} (turn ${m.turnCounter}${d.legal ? ', legal' : ''})`);
        return false;
      }
      if (act.a === 'repick' && m.t === 'reveal' && !r.s.done) {
        r.s.done = true;
        this.repick(line);
        this.end(r);
      }
    }
    return true;
  }

  /** Another seat's answer to the discard the table is waiting on is still open. */
  private contested(): boolean {
    const g = this.sim.host.game as (GameState & { pending?: { offers: Array<{ seat: number }>; responses: Record<number, unknown> } }) | null;
    if (!g || g.phase !== 'claim' || !g.pending) return false;
    return g.pending.offers.some((o) => o.seat !== 0 && g.pending!.responses[o.seat] === undefined);
  }

  /** The server picks its own share again, now that it holds the phone's (it publishes the new set to the phone). */
  private repick(line: Line): void {
    const h = this.sim.hostInside() as ReturnType<Sim['hostInside']> & { commits(): Array<{ seat: number; hash: string }> };
    if (h.phase !== 'reveal') return;
    const secret = net.makeSecret();
    h.hostSecret = secret;
    h.hostCommit = net.commitFor(secret);
    line.send({ t: 'commits', handNumber: h.snapshot.handNumber, commits: h.commits() });
    this.sim.truth.repicked(h.snapshot.handNumber);
    this.sim.truth.notice('repick', line, true, h.snapshot.handNumber);
  }
}

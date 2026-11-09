import { useEffect, useRef, useState } from 'react';
import type { ClientState } from '@mjm/net';
import { shouldTick, tableEvents, type CueState, type TableEvent } from '../audio/cues';
import type { ReconnectState } from '../logic/reconnect';
import type { Session } from './session';

/** Subscribe to a session's client state (across reconnects) and drive the host's timers when we host. */
export function useSession(session: Session | null): ClientState | null {
  const [state, setState] = useState<ClientState | null>(session?.client.state ?? null);
  useEffect(() => {
    if (!session) return;
    setState(session.client.state);
    const unsub = session.onChange(setState);
    const tick = session.host ? setInterval(() => session.host!.tick(), 400) : null;
    return () => {
      unsub();
      if (tick) clearInterval(tick);
    };
  }, [session]);
  return state;
}

/** The session's link to its table: connected, reconnecting (with the attempt) or lost. */
export function useConnection(session: Session | null): ReconnectState {
  const read = (): ReconnectState => ({ status: session?.status ?? 'connected', attempt: session?.attempt ?? 0, reason: session?.lostReason ?? null });
  const [conn, setConn] = useState<ReconnectState>(read);
  useEffect(() => {
    setConn({ status: session?.status ?? 'connected', attempt: session?.attempt ?? 0, reason: session?.lostReason ?? null });
    return session?.onStatus(setConn);
  }, [session]);
  return conn;
}

/** Whole seconds left until `deadline` (ms epoch) at `now`, never negative; null without a deadline. */
export function secondsLeft(deadline: number | null, now: number): number | null {
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Seconds remaining until `deadline` (ms epoch), checked every 250 ms while there is a deadline and changing
 * once a second. Only the component that calls it re-renders: the table keeps it in small leaf components
 * (the HUD clock, the seat timer ring, the clock ticker; components/table/ClockParts.tsx) so the whole screen does not
 * re-render every second.
 */
export function useCountdown(deadline: number | null): number | null {
  const [s, setS] = useState(() => ({ deadline, left: secondsLeft(deadline, Date.now()) }));
  useEffect(() => {
    const tick = () =>
      setS((p) => {
        const left = secondsLeft(deadline, Date.now());
        return p.deadline === deadline && p.left === left ? p : { deadline, left };
      });
    tick();
    if (deadline === null) return;
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);
  return s.deadline === deadline ? s.left : secondsLeft(deadline, Date.now());
}

/**
 * Table events (discards, calls, results) for each new client state, handed to `onEvents` once each. The
 * first state after mounting only sets the baseline, so returning to the table never replays old calls.
 */
export function useTableEvents(state: ClientState | null, onEvents: (events: TableEvent[]) => void): void {
  const prev = useRef<CueState | null>(null);
  const cb = useRef(onEvents);
  cb.current = onEvents;
  useEffect(() => {
    const next: CueState | null = state ? { view: state.view, lastResult: state.lastResult, lastAudit: state.lastAudit, seat: state.seat } : null;
    const events = tableEvents(prev.current, next);
    prev.current = next;
    if (events.length) cb.current(events);
  }, [state]);
}

/** Calls `onTick` once per second for the last five seconds of my own move. */
export function useClockTick(countdown: number | null, myMove: boolean, onTick: () => void): void {
  const prev = useRef<number | null>(null);
  const cb = useRef(onTick);
  cb.current = onTick;
  useEffect(() => {
    if (shouldTick(prev.current, countdown, myMove)) cb.current();
    prev.current = countdown;
  }, [countdown, myMove]);
}

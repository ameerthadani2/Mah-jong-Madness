import { useEffect, useRef, useState } from 'react';
import type { ClientState } from '@mjm/net';
import type { Session } from './session';

/** Subscribe to a session's client state and drive the host's timers when we host. */
export function useSession(session: Session | null): ClientState | null {
  const [state, setState] = useState<ClientState | null>(session?.client.state ?? null);
  useEffect(() => {
    if (!session) return;
    setState(session.client.state);
    const unsub = session.client.onChange(setState);
    const tick = session.host ? setInterval(() => session.host!.tick(), 400) : null;
    return () => {
      unsub();
      if (tick) clearInterval(tick);
    };
  }, [session]);
  return state;
}

/** Seconds remaining until `deadline` (ms epoch), updated every 250ms. */
export function useCountdown(deadline: number | null): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const ref = useRef(deadline);
  ref.current = deadline;
  useEffect(() => {
    const id = setInterval(() => {
      const d = ref.current;
      setLeft(d === null ? null : Math.max(0, Math.ceil((d - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(id);
  }, []);
  return deadline === null ? null : left;
}

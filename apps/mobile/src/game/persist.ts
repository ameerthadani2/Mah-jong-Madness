/**
 * When the record of the table we sit at is written to storage (src/app-state.tsx keeps it for
 * Home's Resume card). Most changes are saved a moment later, so a burst of them costs one write;
 * a change that comes while a save is waiting rides on it, and does not put it off, so a table
 * whose frames never stop (a seat list re-sent every few hundred ms) cannot keep the record from
 * being written. A change that arrives while the table client is agreeing a deal is saved at once:
 * the record then says that this phone has committed to (or revealed in) an attempt, and an app
 * killed in the next instant comes back knowing it. That only narrows the window: the first hand
 * after a restart stays amber, because a restarted app cannot prove the save happened
 * (docs/FAIRNESS.md). So is the change that says the seat was opened on another device: the table
 * screen goes soon after, and a save still waiting goes with it, while Home's Resume restores what
 * was saved last; and the one that says another device held the seat before this client took it
 * back (the table's first welcome to it): a client restored from an older record would not know.
 */
import type { ClientState } from '@mjm/net';

export const SAVE_DELAY_MS = 400;

type Timer = ReturnType<typeof setTimeout>;

export interface SaveScheduler {
  /**
   * Something about the table changed. Pass the table client's ceremony state when the change is
   * the client's own; leave it out for a change of anything else (a local table's host). `now`:
   * save at once whatever the ceremony.
   */
  changed(ceremony?: ClientState['ceremony'], now?: boolean): void;
  /** Drop a save that is still waiting (the screen is going away). */
  cancel(): void;
}

/** True while the table client is in the middle of agreeing a deal. */
export function midCeremony(ceremony: ClientState['ceremony'] | undefined): boolean {
  return ceremony === 'committed' || ceremony === 'revealed';
}

export function saveScheduler(save: () => void, delayMs: number = SAVE_DELAY_MS): SaveScheduler {
  let timer: Timer | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    changed(ceremony, now = false) {
      if (now || midCeremony(ceremony)) {
        // In place of a save that was waiting: one write carries the latest record.
        cancel();
        save();
        return;
      }
      // A save that is waiting reads the record when it runs, so it carries this change too.
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        save();
      }, delayMs);
    },
    cancel,
  };
}

/**
 * What the table client's changes do to the save (`scheduler`): each is saved, and at once the
 * moment the seat is opened on another device (the client turns `kicked`), or the table's first
 * welcome says another device held the seat (the client turns `heldElsewhere`): a client restored
 * from the record later must know that the moves made meanwhile may be that device's.
 */
export function clientSaves(scheduler: SaveScheduler, initial: Pick<ClientState, 'kicked'> & Partial<Pick<ClientState, 'heldElsewhere'>>): (st: Pick<ClientState, 'ceremony' | 'kicked'> & Partial<Pick<ClientState, 'heldElsewhere'>>) => void {
  let kicked = initial.kicked;
  let held = initial.heldElsewhere === true;
  return (st) => {
    const now = (st.kicked && !kicked) || (st.heldElsewhere === true && !held);
    kicked = st.kicked;
    held = st.heldElsewhere === true;
    scheduler.changed(st.ceremony, now);
  };
}

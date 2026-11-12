/**
 * When the record of the table we sit at is written to storage (src/app-state.tsx keeps it for
 * Home's Resume card). Most changes are saved a moment later, so a burst of them costs one write.
 * A change that arrives while the table client is agreeing a deal is saved at once: the record
 * then says that this phone has committed to (or revealed in) an attempt, and an app killed in
 * the next instant comes back knowing it. That only narrows the window: the first hand after a
 * restart stays amber, because a restarted app cannot prove the save happened (docs/FAIRNESS.md).
 */
import type { ClientState } from '@mjm/net';

export const SAVE_DELAY_MS = 400;

type Timer = ReturnType<typeof setTimeout>;

export interface SaveScheduler {
  /**
   * Something about the table changed. Pass the table client's ceremony state when the change is
   * the client's own; leave it out for a change of anything else (a local table's host).
   */
  changed(ceremony?: ClientState['ceremony']): void;
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
    changed(ceremony) {
      // Either way the waiting save is replaced: one write carries the latest record.
      cancel();
      if (midCeremony(ceremony)) {
        save();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        save();
      }, delayMs);
    },
    cancel,
  };
}

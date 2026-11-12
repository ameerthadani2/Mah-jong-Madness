import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DELAY_MS, midCeremony, saveScheduler } from './persist';

describe('saving the table record', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves an ordinary change a moment later, once for a burst of changes', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    s.changed('idle');
    s.changed();
    s.changed('idle');
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves at once when the client commits to a deal and again when it reveals', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    s.changed('committed');
    expect(save).toHaveBeenCalledTimes(1);
    s.changed('revealed');
    expect(save).toHaveBeenCalledTimes(2);
    // Nothing is left waiting: the record on disk is already the latest.
    vi.advanceTimersByTime(5 * SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('saves at once for every attempt at a deal, not only the first', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    // A deal that is restarted before anyone reveals asks for a second commitment: the state reads 'committed' both times.
    s.changed('committed');
    s.changed('committed');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('an immediate save takes the place of one that was waiting', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    s.changed('idle');
    s.changed('committed');
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('goes back to saving a moment later once the hand is dealt', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    s.changed('revealed');
    s.changed('idle');
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a change of the local host alone waits, even in the middle of a deal', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    s.changed('committed');
    s.changed();
    s.changed();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a cancelled save never runs', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    s.changed('idle');
    s.cancel();
    vi.advanceTimersByTime(5 * SAVE_DELAY_MS);
    expect(save).not.toHaveBeenCalled();
    s.cancel();
  });

  it('counts committed and revealed as the middle of a deal, and nothing else', () => {
    expect(midCeremony('committed')).toBe(true);
    expect(midCeremony('revealed')).toBe(true);
    expect(midCeremony('idle')).toBe(false);
    expect(midCeremony(undefined)).toBe(false);
  });
});

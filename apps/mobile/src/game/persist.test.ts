import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DELAY_MS, clientSaves, midCeremony, saveScheduler } from './persist';

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

  it('does not put a waiting save off for changes that keep coming: a table that re-sends its seat list every 300 ms still has each change saved within 400 ms', () => {
    const saves: number[] = [];
    const s = saveScheduler(() => saves.push(Date.now()));
    const changes: number[] = [];
    for (let t = 0; t < 12; t++) {
      changes.push(Date.now());
      s.changed('idle');
      vi.advanceTimersByTime(300);
    }
    vi.advanceTimersByTime(5 * SAVE_DELAY_MS);
    for (const c of changes) expect(saves.find((x) => x >= c)! - c).toBeLessThanOrEqual(SAVE_DELAY_MS);
    // Still a write per burst of changes, not one per change.
    expect(saves.length).toBe(6);
  });

  it('saves at once when asked to, in place of a waiting save', () => {
    const save = vi.fn();
    const s = saveScheduler(save);
    s.changed('idle');
    s.changed('idle', true);
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves the table client’s changes at once the moment the seat is opened on another device, and a moment later otherwise', () => {
    const save = vi.fn();
    const onChange = clientSaves(saveScheduler(save), { kicked: false });
    onChange({ ceremony: 'idle', kicked: false });
    expect(save).not.toHaveBeenCalled();
    onChange({ ceremony: 'idle', kicked: true });
    expect(save).toHaveBeenCalledTimes(1);
    // Frames that still come after it are saved a moment later, as any change.
    onChange({ ceremony: 'idle', kicked: true });
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    // A client restored after the kick starts from where it is.
    const again = vi.fn();
    clientSaves(saveScheduler(again), { kicked: true })({ ceremony: 'idle', kicked: true });
    expect(again).not.toHaveBeenCalled();
  });

  it('counts committed and revealed as the middle of a deal, and nothing else', () => {
    expect(midCeremony('committed')).toBe(true);
    expect(midCeremony('revealed')).toBe(true);
    expect(midCeremony('idle')).toBe(false);
    expect(midCeremony(undefined)).toBe(false);
  });
});

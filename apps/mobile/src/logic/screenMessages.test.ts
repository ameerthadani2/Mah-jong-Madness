import { describe, expect, it } from 'vitest';
import { messagesAfter, NO_MESSAGES, shownError, type ScreenMessageEvent, type ScreenMessages } from './screenMessages';

const run = (events: ScreenMessageEvent[], from: ScreenMessages = NO_MESSAGES) => events.reduce(messagesAfter, from);

describe('the error and notice lines of a screen that polls', () => {
  it('keeps the refusal of an action on screen through the background refreshes that follow', () => {
    const m = run([{ type: 'actionStarted' }, { type: 'actionFailed', text: 'Wait a few seconds and try again.' }, { type: 'loaded' }, { type: 'loaded' }]);
    expect(shownError(m)).toBe('Wait a few seconds and try again.');
  });

  it('clears the refusal when the player presses something else or changes tab', () => {
    const refused = run([{ type: 'actionFailed', text: 'refused' }]);
    expect(shownError(run([{ type: 'actionStarted' }], refused))).toBeNull();
    expect(shownError(run([{ type: 'moved' }], refused))).toBeNull();
    expect(shownError(run([{ type: 'dismissed' }], refused))).toBeNull();
  });

  it('shows a failed refresh until one succeeds, without touching what an action reported', () => {
    const down = run([{ type: 'loadFailed', text: 'Cannot reach the game server.' }]);
    expect(shownError(down)).toBe('Cannot reach the game server.');
    expect(shownError(run([{ type: 'loaded' }], down))).toBeNull();
    const both = run([{ type: 'actionFailed', text: 'refused' }], down);
    expect(shownError(both)).toBe('refused');
    expect(shownError(run([{ type: 'loaded' }], both))).toBe('refused');
    expect(shownError(run([{ type: 'actionStarted' }], both))).toBe('Cannot reach the game server.');
  });

  it('shows a success notice until it expires, the next press or a tab change, and never beside a refusal', () => {
    const done = run([{ type: 'actionDone', notice: 'Requests rejected.' }]);
    expect(done.notice).toBe('Requests rejected.');
    expect(run([{ type: 'loaded' }], done).notice).toBe('Requests rejected.');
    expect(run([{ type: 'noticeExpired' }], done).notice).toBeNull();
    expect(run([{ type: 'moved' }], done).notice).toBeNull();
    expect(run([{ type: 'actionStarted' }], done).notice).toBeNull();
    expect(run([{ type: 'actionFailed', text: 'refused' }], done)).toEqual({ loadError: null, actionError: 'refused', notice: null });
    expect(run([{ type: 'actionDone' }], run([{ type: 'actionFailed', text: 'refused' }]))).toEqual(NO_MESSAGES);
  });

  it('returns the same object when nothing changed, so a poll does not re-render the screen', () => {
    expect(messagesAfter(NO_MESSAGES, { type: 'loaded' })).toBe(NO_MESSAGES);
    expect(messagesAfter(NO_MESSAGES, { type: 'moved' })).toBe(NO_MESSAGES);
    const down = run([{ type: 'loadFailed', text: 'x' }]);
    expect(messagesAfter(down, { type: 'loadFailed', text: 'x' })).toBe(down);
  });
});

import { describe, expect, it } from 'vitest';
import { APP_ROOT_ID, holdPageInert } from './inert';

/** A stand-in page: the app's root element, with its attributes. */
function page() {
  const attrs = new Map<string, string>();
  const root = { setAttribute: (n: string, v: string) => void attrs.set(n, v), removeAttribute: (n: string) => void attrs.delete(n) };
  return { attrs, getElementById: (id: string) => (id === APP_ROOT_ID ? root : null) };
}

describe('the page behind an open dialog', () => {
  it('is inert while the dialog is open, and comes back when it closes', () => {
    const p = page();
    const release = holdPageInert(p);
    expect(p.attrs.has('inert')).toBe(true);
    release();
    expect(p.attrs.has('inert')).toBe(false);
  });

  it('stays inert until the last of two dialogs closes, whichever closes first', () => {
    const p = page();
    const first = holdPageInert(p);
    const second = holdPageInert(p);
    first();
    expect(p.attrs.has('inert')).toBe(true);
    // A release called twice (an effect cleaned up again) does not free the other dialog's hold.
    first();
    expect(p.attrs.has('inert')).toBe(true);
    second();
    expect(p.attrs.has('inert')).toBe(false);
  });

  it('does nothing where there is no page or no app root (iOS and Android)', () => {
    expect(() => holdPageInert(undefined)()).not.toThrow();
    expect(() => holdPageInert({ getElementById: () => null })()).not.toThrow();
  });
});

/**
 * While a dialog is open on the web, the rest of the page is inert: no Tab stop, no click, and hidden from screen
 * readers, including those that ignore aria-modal. React Native Web draws a Modal in a portal beside the app's root
 * element (`#root`), so marking the root inert leaves the dialog itself alone. The holds are counted, so a dialog
 * opened over another keeps the page inert until the last one closes. Pure, so it is tested with a stand-in page;
 * components use `useInertPage` (components/Scrim.tsx), which does nothing on iOS and Android, where a Modal is a
 * window of its own.
 */

/** The part of a page this needs: the app's root element by its id. */
export interface InertPage {
  getElementById(id: string): { setAttribute(name: string, value: string): void; removeAttribute(name: string): void } | null;
}

/** The id of the element Expo's web page renders the app into. */
export const APP_ROOT_ID = 'root';

const holds = new WeakMap<object, number>();

/** Makes the app root inert until the returned release is called (once; later calls do nothing). */
export function holdPageInert(page: InertPage | undefined = (globalThis as { document?: InertPage }).document): () => void {
  const root = page?.getElementById?.(APP_ROOT_ID);
  if (!root) return () => undefined;
  holds.set(root, (holds.get(root) ?? 0) + 1);
  root.setAttribute('inert', '');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = Math.max(0, (holds.get(root) ?? 1) - 1);
    holds.set(root, left);
    if (left === 0) root.removeAttribute('inert');
  };
}

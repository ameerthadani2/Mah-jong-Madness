/** Platforms where the table announces call-outs and banners itself: iOS only (Android uses live regions). */
export function announcesOn(os: string): boolean {
  return os === 'ios';
}

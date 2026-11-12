/**
 * The type size for a club's name in its screen header. A club name is up to 40 characters the owner typed, and
 * the header shows all of it: short names keep the display size, longer ones step down so that even the longest
 * (40 full-width characters) takes at most four lines on the narrowest phone.
 */

/** Rough drawn width in ems: a full-width (CJK, kana, full-width form) character is 1 em, anything else about half. */
export function titleEms(title: string): number {
  let ems = 0;
  for (const ch of title) ems += /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch) ? 1 : 0.5;
  return ems;
}

export const TITLE_SIZES = [30, 24, 20] as const;

export function clubTitleSize(name: string): number {
  const ems = titleEms(name.trim());
  if (ems <= 9) return TITLE_SIZES[0];
  if (ems <= 20) return TITLE_SIZES[1];
  return TITLE_SIZES[2];
}

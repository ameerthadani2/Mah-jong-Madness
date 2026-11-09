/** The spoken name of a tile for screen readers, in the UI language (pure, shared by every tile drawn). */
import { kindInfo, type Kind } from '@mjm/engine';

export function tileLabel(kind: Kind, locale: string): string {
  const info = kindInfo(kind);
  return locale === 'zh-TW' ? info.nameZh : info.nameEn;
}

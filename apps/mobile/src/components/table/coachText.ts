/**
 * What the coach says, as two sentences in the reader's language: the status of the hand as a whole, and the advice,
 * the one thing to do now. Pure (the translator is passed in), so the choice is unit-tested; CoachBar shows the advice
 * first and the coach's sheet shows everything (./CoachPanel.tsx).
 */
import type { Hint } from '@mjm/engine';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface CoachLines {
  /** How far the hand is from ready, that it is ready and on what, or that it can win now. */
  status: string;
  /** The win and what it scores, the tile to discard, or the claim to make; null when the coach has nothing to do now. */
  advice: string | null;
}

/** The coach's two sentences for `hint`. Engine sentences are reason keys rendered under `engine.` (src/i18n/index.ts). */
export function coachLines(hint: Hint, t: Translate): CoachLines {
  const engine = (key: string, params?: Record<string, string | number>) => t(`engine.${key}`, params);
  const status = engine(hint.statusKey, hint.statusParams);
  if (hint.winPreview) {
    const items = hint.winPreview.items.map((i) => t('table.coach.taiItem', { name: i.nameZh, tai: i.tai })).join(' · ');
    return { status, advice: t('table.coach.winPreview', { items, tai: hint.winPreview.tai }) };
  }
  if (hint.discardReasonKey) return { status, advice: engine(hint.discardReasonKey, hint.discardReasonParams) };
  // A claim chance: the claim the coach recommends, named, with its reason (passing has no line of its own).
  const rec = hint.claims.find((c) => c.recommended);
  if (rec) return { status, advice: t('table.coach.claimLine', { label: engine(rec.labelKey, rec.labelParams), reason: engine(rec.reasonKey, rec.reasonParams) }) };
  return { status, advice: null };
}

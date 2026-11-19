/**
 * The engine's coach and review sentences are templates it exports per locale (engineReasonTranslations); the app shows
 * them under 'engine.' (./index.ts). A few read in the app's own wording instead (ENGINE_WORDING).
 */
import { engineReasonTranslations } from '@mjm/engine';
import type { Locale } from './resolve';

/**
 * The app's own wording for a few of the engine's templates. English names the claim 吃 "Chow" on the claim buttons, in
 * their spoken names and in the review, so the coach's bar and sheet say Chow too, not the engine's "Chi": one name for
 * one button.
 */
export const ENGINE_WORDING: Record<Locale, Record<string, string>> = {
  en: { 'hint.label.chi': 'Chow (吃) %{handTiles} + %{tileName}' },
  'zh-TW': {},
};

/** The engine's templates for a locale (nested by key, as engineReasonTranslations gives them), with the app's wording over them. */
export function engineStrings(locale: Locale): Record<string, unknown> {
  const out = engineReasonTranslations(locale);
  for (const [key, text] of Object.entries(ENGINE_WORDING[locale])) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]] = text;
  }
  return out;
}

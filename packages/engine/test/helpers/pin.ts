/**
 * Decisions at tables that do not play 嚦咕嚦咕 (`liguTai` 0), pinned so that teaching the bots and
 * the coach that hand changes nothing there. `pinnedDecisions()` plays fixed seeds with Club bots and,
 * every few steps, asks each skill and the coach what they would do for every seat that has a move.
 * The result was recorded before the bots knew the hand (`test/fixtures/ligu-off-decisions.json`)
 * and `test/ligu_bots.test.ts` checks that it is unchanged.
 */
import { applyAction, chooseAction, hintFor, newGame, type BotSkill, type GameState } from '../../src/index';

/** States sampled, and how often (every `STRIDE`-th step of a hand). */
export const PIN_STATES = 300;
const STRIDE = 3;
const SKILLS: readonly BotSkill[] = ['beginner', 'club', 'pro'];

/** One line per sampled state: each seat's move by skill and the coach's hint, as compact text. */
export function pinnedDecisions(): string[] {
  const out: string[] = [];
  for (let g = 0; out.length < PIN_STATES; g++) {
    let s: GameState = newGame(`ligu-pin-${g}`);
    for (let step = 0; s.phase !== 'ended' && out.length < PIN_STATES && step < 3000; step++) {
      if (step % STRIDE === 0) {
        const parts: string[] = [];
        for (let seat = 0; seat < 4; seat++) {
          const moves = SKILLS.map((skill) => JSON.stringify(chooseAction(s, seat, { skill, seed: `pin${seat}` })));
          if (moves[0] === 'null') continue;
          const h = hintFor(s, seat);
          parts.push(`${seat}:${moves.join('|')}|${h.shanten}|${h.statusKey}|${h.bestDiscard?.kind ?? '-'}|${h.discardReasonKey ?? '-'}|${h.claims.map((c) => `${c.reasonKey}${c.recommended ? '+' : ''}`).join(',')}`);
        }
        if (parts.length > 0) out.push(`${g}.${step} ${parts.join(' ')}`);
      }
      for (let seat = 0; seat < 4; seat++) {
        const a = chooseAction(s, seat, { skill: 'club', seed: `run${seat}` });
        if (a) {
          s = applyAction(s, seat, a);
          break;
        }
      }
    }
  }
  return out;
}

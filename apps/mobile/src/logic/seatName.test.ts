import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { BOT_NAME_SLOT, botBaseName, botNamer, estimateTextWidth, relLineExtra, relTagLabel, seatDisplayName, seatTagText, SEAT_TAG_CHROME, SIDE_NAME_MIN_SIZE, sideNameSize, withBotLabels } from './seatName';

const fill = (template: string) => (name: string) => template.replace('%{name}', name);
const enBot = fill(en.common.botName);
const zhBot = fill(zhTW.common.botName);

describe('bot seat names', () => {
  it("takes the host's English label off a bot's name", () => {
    expect(botBaseName('阿明 (Bot)')).toBe('阿明');
    expect(botBaseName('小美 (bot)')).toBe('小美');
    expect(botBaseName('老王')).toBe('老王');
  });

  it('labels a bot in the reader\'s language: no "(Bot)" on the zh-TW table', () => {
    expect(seatDisplayName({ name: '阿花 (Bot)', isBot: true }, zhBot)).toBe('阿花（電腦）');
    expect(seatDisplayName({ name: '阿花 (Bot)', isBot: true }, zhBot)).not.toMatch(/bot/i);
    expect(seatDisplayName({ name: '阿花 (Bot)', isBot: true }, enBot)).toBe('阿花 (Bot)');
    // A bot the host named without a label still gets one.
    expect(seatDisplayName({ name: '阿花', isBot: true }, zhBot)).toBe('阿花（電腦）');
  });

  it("never touches a player's name, whatever it says", () => {
    expect(seatDisplayName({ name: 'Rob (Bot)', isBot: false }, zhBot)).toBe('Rob (Bot)');
    expect(seatDisplayName({ name: 'Rob (Bot)' }, zhBot)).toBe('Rob (Bot)');
  });

  it('renames the bot seats of a table state and leaves the rest of it alone', () => {
    const state = { roomCode: 'ABC123', seats: [{ seat: 0, name: 'Tester', isBot: false }, { seat: 1, name: '小美 (Bot)', isBot: true }] };
    const shown = withBotLabels(state, zhBot);
    expect(shown.seats.map((s) => s.name)).toEqual(['Tester', '小美（電腦）']);
    expect(shown.roomCode).toBe('ABC123');
    expect(shown.seats[0]).toBe(state.seats[0]);
    // Nothing to change: the same object, so nothing re-renders for it.
    const humans = { seats: [{ seat: 0, name: 'Tester', isBot: false }] };
    expect(withBotLabels(humans, zhBot)).toBe(humans);
  });

  it('names bots from the sentence translated once for the language', () => {
    expect(botNamer(zhBot(BOT_NAME_SLOT))('阿明')).toBe('阿明（電腦）');
    expect(botNamer(enBot(BOT_NAME_SLOT))('阿明')).toBe('阿明 (Bot)');
  });

  it('is applied where seats are shown: the lobby', () => {
    // The table naming its bots in the player's language is rendered in src/screens/TablePlay.render.test.tsx ("the seats").
    for (const screen of ['LobbyScreen.tsx']) {
      const src = readFileSync(join(__dirname, '../screens', screen), 'utf8');
      expect(src, screen).toContain("const botLabel = t('common.botName', { name: BOT_NAME_SLOT });");
      expect(src, screen).toContain('withBotLabels(tableState, botNamer(botLabel))');
    }
  });
});

describe('a seat name tag', () => {
  it('measures CJK and full-width characters at one em: 小美（電腦） is 72 px at 12 px', () => {
    expect(estimateTextWidth('小美（電腦）', 12)).toBe(72);
    expect(estimateTextWidth('Mei', 12)).toBeCloseTo(22.3, 1);
  });

  it('keeps a name that fits on one line', () => {
    expect(seatTagText('小美（電腦）', 110 - SEAT_TAG_CHROME)).toBe('小美（電腦）');
    expect(seatTagText('Tester', 62)).toBe('Tester');
  });

  it('breaks a name that does not fit before its label, never inside the name (the 360 px side seats: 68 px)', () => {
    expect(seatTagText('阿花（電腦）', 68)).toBe('阿花\n（電腦）');
    expect(seatTagText('老王（電腦）', 62)).toBe('老王\n（電腦）');
    expect(seatTagText('Old Wang (Bot)', 60)).toBe('Old Wang\n(Bot)');
    // No label to break at: the text wraps where it allows (the tag shows two lines).
    expect(seatTagText('Wonderfully Long Name', 60)).toBe('Wonderfully Long Name');
  });
});

describe('relTagLabel', () => {
  it('keeps the relation label whole on one line, falling back to the short form where it would not fit', () => {
    // The right seat's tag on a 667 x 375 phone has 84 px (side column 128, its 32 px plate, 12 px of gaps).
    expect(relTagLabel('Right 下家', 'Right', 84 - SEAT_TAG_CHROME)).toBe('Right');
    // The across seat's 120 px tag fits the whole label.
    expect(relTagLabel('Across 對家', 'Across', 120 - SEAT_TAG_CHROME)).toBe('Across 對家');
    // Chinese is two characters either way.
    expect(relTagLabel('下家', '下家', 84 - SEAT_TAG_CHROME)).toBe('下家');
    // A larger OS text size can push the whole label out.
    expect(relTagLabel('Across 對家', 'Across', 120 - SEAT_TAG_CHROME, 11 * 1.5)).toBe('Across');
  });
});

describe("a side seat's name on one line", () => {
  // A landscape side seat at 667 x 375: a 128 px column, a 32 px plate and 12 px between them.
  const side = 128 - 32 - 12 - SEAT_TAG_CHROME;

  it('keeps a name that fits at its usual size', () => {
    expect(sideNameSize('Tester', side)).toBe(12);
  });

  it("shrinks a bot's name with its label just enough to stay on one line, in both languages and at a larger text size", () => {
    for (const [name, base] of [
      ['阿花 (Bot)', 12],
      ['小美（電腦）', 12],
      ['小美（電腦）', 12 * 1.3],
    ] as const) {
      const size = sideNameSize(name, side, base)!;
      expect(size, name).toBeLessThan(base);
      expect(size, name).toBeGreaterThanOrEqual(SIDE_NAME_MIN_SIZE);
      expect(estimateTextWidth(name, size), name).toBeLessThanOrEqual(side);
    }
  });

  it('gives up on a long typed name, which keeps two lines rather than being cut', () => {
    expect(sideNameSize('Christopher Wellington', side)).toBeNull();
  });

  it('leaves room on the relation line for the score and the offline word', () => {
    expect(relLineExtra(0, null)).toBeLessThan(relLineExtra(-1250, null));
    expect(relLineExtra(0, 'Offline')).toBeGreaterThan(relLineExtra(0, null));
    // With a four-digit score the full label no longer fits beside it, so the short one is shown.
    expect(relTagLabel('Right 下家', 'Right', side - relLineExtra(-1250, null))).toBe('Right');
  });
});

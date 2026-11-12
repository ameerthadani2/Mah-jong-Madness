import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { BOT_NAME_SLOT, botBaseName, botNamer, seatDisplayName, withBotLabels } from './seatName';

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

  it('is applied where seats are shown: the table (with its sheets) and the lobby', () => {
    for (const screen of ['TableScreen.tsx', 'LobbyScreen.tsx']) {
      const src = readFileSync(join(__dirname, '../screens', screen), 'utf8');
      expect(src, screen).toContain("const botLabel = t('common.botName', { name: BOT_NAME_SLOT });");
      expect(src, screen).toContain('withBotLabels(tableState, botNamer(botLabel))');
    }
  });
});

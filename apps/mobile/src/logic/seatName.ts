/**
 * Bot seats as a player reads them. The table host names its bots "阿明 (Bot)" in every language
 * (packages/net/src/host.ts; older clients show the name as it comes). Here the host's English label is taken
 * off and the app's own word put on in the reader's language (`common.botName`: "阿明 (Bot)", "阿明（電腦）"),
 * once, for every place a seat's name is shown: the plates, the status line, the result and match-over
 * sheets and the lobby.
 */
const HOST_BOT_LABEL = /\s*[(（]\s*bot\s*[)）]\s*$/i;

/** A bot's own name, without the host's "(Bot)". */
export function botBaseName(name: string): string {
  return name.replace(HOST_BOT_LABEL, '');
}

/** The name to show for a seat: a bot's with the label in the reader's language, a player's as it is. */
export function seatDisplayName(seat: { name: string; isBot?: boolean }, botName: (name: string) => string): string {
  if (!seat.isBot) return seat.name;
  const base = botBaseName(seat.name);
  return base ? botName(base) : seat.name;
}

/** `state` with its bot seats named for the reader; the same object when there is nothing to change. */
export function withBotLabels<S extends { seats: ReadonlyArray<{ name: string; isBot?: boolean }> }>(state: S, botName: (name: string) => string): S {
  let changed = false;
  const seats = state.seats.map((s) => {
    const name = seatDisplayName(s, botName);
    if (name === s.name) return s;
    changed = true;
    return { ...s, name };
  });
  return changed ? { ...state, seats } : state;
}

/** Stands for the bot's name in the `common.botName` sentence, so a screen can translate it once per language. */
export const BOT_NAME_SLOT = '\u0000';

/** Names bots with a translated `common.botName` sentence in which BOT_NAME_SLOT stands for the name. */
export function botNamer(sentence: string): (name: string) => string {
  return (name) => sentence.split(BOT_NAME_SLOT).join(name);
}

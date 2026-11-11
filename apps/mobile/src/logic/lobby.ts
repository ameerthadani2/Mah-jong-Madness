/**
 * What the lobby offers at a table, kept pure so it is unit-tested.
 *
 * A quick-match table is closed to everyone but the accounts the server matched (anyone else gets
 * `room_unavailable`) and starts by itself, so its lobby has no code to share, no invite link, and
 * no Add bot or Start buttons: each of them would promise something that cannot happen there.
 */
export interface LobbyControls {
  /** "Share this code", the big code and the invite link. */
  share: boolean;
  addBot: boolean;
  start: boolean;
}

export function lobbyControls(table: { quickMatch?: boolean }): LobbyControls {
  const open = table.quickMatch !== true;
  return { share: open, addBot: open, start: open };
}

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

/**
 * Whether this player has a seat at the table. The socket being in the room is not a seat: a full table,
 * or one already playing, refuses the join, and the lobby then shows the reason and Back, nothing else.
 */
export function lobbySeated(state: { seat: number | null }): boolean {
  return state.seat !== null;
}

/**
 * Whether the table's header shows the table code: only where the code is of use to someone, an online
 * table that others can join by it (never the local table, never a quick-match table, whose lobby hides
 * it for the same reason), and only in landscape, where the header has the room.
 */
export function hudShowsCode(table: { roomCode: string; quickMatch?: boolean }, portrait: boolean): boolean {
  return table.roomCode !== 'LOCAL' && table.quickMatch !== true && !portrait;
}

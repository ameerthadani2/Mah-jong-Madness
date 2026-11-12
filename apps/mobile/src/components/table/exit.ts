/**
 * What the table's exit button does, as data, so the rule is testable without rendering:
 *
 * - The red exit icon never leaves on its own: it opens the exit sheet (`onExitIcon`).
 * - "Keep playing" closes the sheet and changes nothing.
 * - "Back to Home" steps away: the table is closed on this device but its saved record stays, so the Home
 *   resume card brings the player back (online, a bot plays the seat meanwhile; offline, the table waits).
 *   At a quick-match table the link is closed without the table's `leave` (`keepSeat`): the server closes
 *   such a table at once when every player left on purpose, and only keeps it (two minutes with nobody
 *   connected) for players who dropped, which is what stepping away must look like there.
 * - Only "Abandon table" forgets the table (the session and the saved record both go).
 */
export type ExitChoice = 'stay' | 'away' | 'abandon';

export interface ExitPlan {
  /** Close the live session on this device. */
  closeSession: boolean;
  /** Drop the saved record behind the Home resume card. */
  forgetTable: boolean;
  /** Go back to Home. */
  goHome: boolean;
  /** Close the link without telling the table the player left on purpose (game/session.ts `close`). */
  keepSeat: boolean;
}

export function exitPlan(choice: ExitChoice, table: { quickMatch?: boolean } = {}): ExitPlan {
  switch (choice) {
    case 'stay':
      return { closeSession: false, forgetTable: false, goHome: false, keepSeat: false };
    case 'away':
      return { closeSession: true, forgetTable: false, goHome: true, keepSeat: table.quickMatch === true };
    case 'abandon':
      return { closeSession: true, forgetTable: true, goHome: true, keepSeat: false };
  }
}

/** What the exit sheet says under its title: what happens to the seat while the player is away. */
export function leaveSheetBody(table: { online: boolean; quickMatch?: boolean }): string {
  if (!table.online) return 'table.leaveSheet.bodyLocal';
  return table.quickMatch ? 'table.leaveSheet.bodyQuick' : 'table.leaveSheet.bodyOnline';
}

/** The exit icon's tap: it only ever opens the sheet. */
export function onExitIcon(): { openSheet: true; plan: ExitPlan } {
  return { openSheet: true, plan: exitPlan('stay') };
}

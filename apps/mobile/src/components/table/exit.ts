/**
 * What the table's exit button does, as data, so the rule is testable without rendering:
 *
 * - The red exit icon never leaves on its own: it opens the exit sheet (`onExitIcon`).
 * - "Keep playing" closes the sheet and changes nothing.
 * - "Back to Home" steps away: the table is closed on this device but its saved record stays, so the Home
 *   resume card brings the player back (online, a bot plays the seat meanwhile; offline, the table waits).
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
}

export function exitPlan(choice: ExitChoice): ExitPlan {
  switch (choice) {
    case 'stay':
      return { closeSession: false, forgetTable: false, goHome: false };
    case 'away':
      return { closeSession: true, forgetTable: false, goHome: true };
    case 'abandon':
      return { closeSession: true, forgetTable: true, goHome: true };
  }
}

/** The exit icon's tap: it only ever opens the sheet. */
export function onExitIcon(): { openSheet: true; plan: ExitPlan } {
  return { openSheet: true, plan: exitPlan('stay') };
}

/**
 * The words of the table client's audit (from client.ts): the status a hand verifies as, why a hand is amber
 * (`AUDIT_CAVEATS`) and what makes it red (`AUDIT_FAILURES`), with the keys the app shows them by (`caveatKey`,
 * `auditFailure`, `failureKey`). Each check writes its sentence where it is made, in the client's files;
 * `test/failure-text.test.ts` reads those files and checks that every sentence has a key here.
 */

/**
 * `ok`: this device watched the whole deal in one attempt, its own share protected the seed, and
 * every check passed.
 * `partial`: every check on the log and the published shares passed, but the server could have
 * picked this deal: the host stood in for this seat, the seat joined mid-hand, the deal was
 * restarted, or this device lost its link while the deal was being agreed.
 * `failed`: a check failed or the host misbehaved during the hand.
 */
export type AuditStatus = 'ok' | 'partial' | 'failed' | 'unverified';

export interface AuditCheck {
  status: AuditStatus;
  failures: string[];
  caveats: string[];
}

/** Why a hand verified only as `partial`. The app translates these by key (see `caveatKey`). */
export const AUDIT_CAVEATS = {
  standIn: "The host supplied this seat's share",
  joined: 'Joined during this hand; log verified, share not used',
  restarted: 'The deal was restarted, so the server could have picked it',
  linkLost: 'This seat lost its connection while the deal was being agreed',
  missedAttempts: 'This seat did not see every attempt at the deal',
  away: 'This device was away when the hand ended; its record was checked afterwards, the play was not watched',
  gap: 'This device missed the hands before this one and was not shown their records, so the scores it started from could not be checked',
  serverRestart: 'The server restarted during this hand and some turns were played again',
  // A second restart notice while the hand was on show (`noteRestore`): its clock was measured afresh within the hand.
  restartedAgain: 'The server said it restarted twice during this hand, so this device measured its clock afresh within the hand',
  appRestart: 'This app was restarted around this deal, so it cannot vouch for all of it',
  tableMoved: 'The table played for this seat while its connection was down',
  // The same, on a turn whose state reached this device too late for its stamp to be believed (the
  // drop judgement's `downLate`), whether or not the link dropped: a delay looks the same as a drop.
  tableMovedLate: 'The table played for this seat on a turn that reached this device late, so it did not see that turn in time',
  // The claim the timeout rule passed for this seat while its link was down. An honest table does
  // this to a player who dropped; a server that cuts the link whenever the player could claim does
  // it every time, and the count over the match (`claimsPassedAway`) shows the pattern.
  passedPong: 'The table passed up a Pong this seat could make while its connection was down',
  passedChow: 'The table passed up a Chow this seat could make while its connection was down',
  passedKong: 'The table passed up a Kong this seat could make while its connection was down',
  // The same, on a turn that reached this device late (counted with `late` in `claimsPassedAway`).
  passedPongLate: 'The table passed up a Pong this seat could make on a turn that reached this device late',
  passedChowLate: 'The table passed up a Chow this seat could make on a turn that reached this device late',
  passedKongLate: 'The table passed up a Kong this seat could make on a turn that reached this device late',
  restartClock: 'The server restarted and then played for this seat before this device could check the time it had left',
  // The table's move for this seat is early only by what this device measured of the server's clock in
  // another run of the app, or of its clock (`across`): its own clock may have been set in between.
  appClock: "This device's clock was started afresh or set during this hand (the app restarted, or the phone's clock was changed), and the server's clock then no longer agreed with it as it had before, so this device cannot be sure the seat's time had run out when the table played for it",
  lateShown: "This seat's turn reached this device late, or after its connection had been down for much of it, so this device cannot vouch that it saw all of that turn",
  skillUnknown: 'This device restored the match from a save that did not keep how strong the table said its bots are, so the moves the table made for bots and for seats out of time were not checked',
  // Storage changed part of the saved record of the hand (a state whose check figure did not match when the
  // app restarted, `cleanSeen`): the checks that would rest on it are not held against the table.
  damaged: 'This app restarted with a damaged record of this hand, so the checks that rest on the damaged part were not made',
  // The table sent more states in this hand than the record keeps (`keepSeen`): no honest table comes near it.
  overflow: 'The table sent this device far more states in this hand than it keeps, so it could not keep them all and cannot vouch for the whole hand',
  // The table played for this seat over a legal move it sent with more of the turn's clock left than the
  // best round trip of the hand and `FLIGHT_SLACK_MS` explain losing on the way (`flightAllowance`).
  inFlight: 'The table played for this seat while a move it had sent in good time was still on its way',
  // The log credits this seat, at a turn, with a move it made on an earlier turn, while it made another move on that turn,
  // or with a pass of a decision that had closed, where it could claim or win (the copy rule, `replayChecked`): a
  // connection slow toward the table delivers the earlier move there, and a server that held it back can play it there.
  lateCopy: 'The table played a move this seat made on an earlier turn at a later one, in place of the move it made there or a claim or win it could have made, so this device cannot vouch for that turn',
  // This device pinged the table through the hand and no answer came back: nothing tied the table's clock to its own.
  noAnswer: "The table did not answer this device's timing checks during this hand",
  // The table moved on past the hand this device was on, while its link was down, and sent no record of it this device
  // could check: the hand's deal, the views it was shown and its moves are unchecked (`closeUnheard`).
  noRecord: 'This device was on this hand when its connection dropped, and the table moved on without sending a record of it that this device could check',
  // The record of the hand before this one did not replay (or could not be read), so nothing chains into this one
  // (`brokenHand`): the scores, dealer and wind it started from are the table's word.
  unchained: 'The record of the hand before this one did not replay, so the scores this hand started from could not be checked',
  // The server said another device held the seat for part of the hand (a seat-taken notice, or `welcome.elsewhere`), and
  // the log credits the player there with a move this device did not send (`PlayRecord.otherDevice`): it may have been
  // made on that device, so it is not held against the table, but nothing vouches for it, and the end of the match is
  // not shown as verified.
  otherDevice: 'The server said this seat was opened on another device during this hand, and the log credits this seat with moves this device did not send there',
  // The app restarted (or the table was taken up again) without its journal of the moves it sent, in a hand whose every
  // move went to the journal first, and the log credits the player with a move the restored record does not hold, from
  // the latest turn the record held until the hand was shown again (`PlayRecord.unjournaled`): it may be one this device
  // sent after the record was written, so it is not held against the table, but nothing vouches for it, and the end of
  // the match is not shown as verified.
  journalLost: "This app restarted without its journal of the moves it sent, and the log credits this seat with moves its record does not hold, so this device cannot vouch for them",
} as const;

export type AuditCaveat = keyof typeof AUDIT_CAVEATS;

/** A claim on another seat's discard that the table can pass for a seat whose link is down. */
export type PassedClaim = 'pong' | 'chow' | 'kong';

/**
 * One hand's turns of this seat whose state reached this device late enough to be counted on the
 * Fair play screen (`lateCountMs`), out of the turns of the seat it could measure in that hand.
 */
export interface LateTurnRecord {
  hand: number;
  /** The turn counters of the seat's moves whose turn reached this device late. */
  late: number[];
  /** How many of the seat's turns in the hand this device could measure. */
  of: number;
}

/** One claim the table passed for this seat while its link was down: the hand and turn, and which claim. */
export interface PassedClaimRecord {
  hand: number;
  turn: number;
  claim: PassedClaim;
  /** On a turn that reached this device late (`downLate`), whether or not its link dropped. */
  late?: boolean;
}

/** The key of a caveat text produced by this client, or null for any other text. */
export function caveatKey(text: string): AuditCaveat | null {
  for (const [k, v] of Object.entries(AUDIT_CAVEATS)) if (v === text) return k as AuditCaveat;
  return null;
}

/**
 * Why a hand failed its checks, or what the host did that it must not. The sentences written in
 * the checks below stay as they are (tests and logs read them); the app shows each one in the
 * player's language by its key (see `failureKey`). An entry is the exact sentence, or a pattern
 * for a sentence that carries a number or a name, whose named groups are the values it carries.
 */
export const AUDIT_FAILURES = {
  // What the host did between hands and around the table.
  dealtPlayedHand: 'Host asked to deal a hand that was already played',
  startedBeforeEnd: 'Host started another hand before the one in progress had ended',
  dealtAfterMatch: 'Host dealt another hand after the match was over',
  dealtOutOfTurn: 'Host dealt a hand out of turn',
  matchStartChanged: /^The match started with (?<fields>[A-Za-z, ]+) different from a new match$/,
  handStartChanged: /^Hand started with (?<fields>[A-Za-z, ]+) different from where the previous hand left them$/,
  botsChanged: 'Host changed which seats are bots during the match',
  skillChanged: 'Host changed how strong its bots are during the match',
  skillUnpublished: 'The table did not say how strong its bots are, yet it made moves for bots or for seats out of time, so none of them could be checked',
  movedMatch: 'Host moved this seat into a different match mid-match',
  // A match the app kept the record of under one room code, run by the table under another: an honest server runs a match
  // under one room code for its life (`TableClientOptions.keptRecord`, `moved`).
  matchRoomMoved: 'Host ran this match under another room code than the one this device kept its record of',
  movedSeat: 'Host moved this seat to another seat mid-match',
  rulesChanged: 'Host changed the rules mid-match',
  redealt: 'Host re-dealt a hand in progress',
  wentBack: 'Host went back to a hand that had already ended',
  resentOtherMatch: 'Host re-sent a hand under a different match id',
  auditChanged: 'Host sent a different audit for a hand it had already ended',
  resultChanged: 'Host re-sent a different result for a hand it had already ended',
  endUnsupported: 'Host announced the end of the match, which the hands this device verified do not support',
  twoStates: /^Host showed two different states for turn (?<turn>-?\d+)$/,
  restartedTwice: 'Host said it restarted this hand more than twice',
  // A frame of a known type that does not carry what an honest host always sends in it, or carries it as another type
  // (`intake`): the client takes nothing from it.
  malformedFrame: 'Host sent a malformed frame',
  // An honest host answers `not_seated` only on a link it seats no one on: on one where it seated this device, which still
  // holds the seat there, the answer leaves a move this seat made there unanswered, unjudged.
  seatDenied: 'Host said this device had no seat on a connection where the table had seated it',
  // A frame about the table on a connection where the host had not seated this device (before its welcome there) or had
  // taken its seat away (after `evicted`): an honest host sends such a connection nothing but pongs and refusals of no move.
  unseatedFrame: 'Host sent table frames on a connection where this device held no seat',
  // A frame naming a hand or turn an honest host would not name at that point: a clock frame for a turn other than the
  // one whose state it last sent the link, or a deal's frame for a hand other than the one being dealt.
  strayFrame: 'Host sent a frame about a hand or turn this device was not on',
  // A restart notice anywhere but on a new link, right after its welcome and the records of the hands missed: a restart
  // drops every link, and the restored table says so as its first word when each device joins again.
  restartMidLink: 'Host said it restarted, but not as its first word when this device joined again',
  // The hands this device was away for.
  missedOtherMatch: 'Host sent the record of a hand from a different match',
  missedBroken: 'The record of the hands this device missed does not follow from the last hand it verified',
  missedWhileConnected: 'Host reported a hand as missed although this device was connected throughout',
  // The table moved on past the hand this device was on without its record, after a join that said which hands this
  // device held: an honest host sends the record of every later hand that ended before anything else (`sendMissed`).
  recordWithheld: 'Host moved on to a later hand without sending the record of this one, which this device asked for when it joined again',
  awayHandFailed: /^The record of hand (?<hand>-?\d+), played while this device was away, failed its checks$/,
  // Agreeing the deal.
  skippedFirstAttempts: /^Host never asked this seat to commit to attempts 1–(?<last>-?\d+) of this hand$/,
  attemptTwice: /^Host ran attempt (?<n>-?\d+) of this hand's deal twice$/,
  skippedAttempt: /^Host never asked this seat to commit to attempt (?<n>-?\d+) of this hand$/,
  commitsMalformed: 'Host published a malformed set of commitments',
  commitsChanged: 'Host changed the commitments after publishing them',
  myCommitDiffers: 'Host published a different commitment for my seat',
  earlyReveal: 'Host asked for my secret before publishing all commitments',
  neverAskedToCommit: 'Host never asked this seat to commit',
  commitsNeverArrived: 'The commitments for this hand never arrived',
  // The record of a hand.
  noContext: 'No match context',
  auditMalformed: 'The audit is malformed',
  auditOtherMatch: 'The audit is for a different match than the one this seat is in',
  myCommitAltered: 'Host altered my commitment',
  mySecretAltered: 'Host altered my secret',
  commitChangedAfter: /^Commitment for seat (?<seat>-?\d+) changed after the fact$/,
  commitCount: 'Audit must list exactly one commitment for each of seats 0–4',
  revealCount: 'Audit must list exactly one secret for each of seats 0–4',
  revealsMismatch: /^Reveals do not match commitments for seats (?<seats>[\d, ]*)$/,
  seedMismatch: 'Seed was not derived from the revealed secrets',
  unknownShuffle: /^Unknown shuffle construction (?<version>[\s\S]*)$/,
  // Replaying the hand.
  replayMismatch: 'Replaying the action log does not reproduce the final state',
  replayFailed: /^Replay failed: (?<detail>[\s\S]*)$/,
  // Every check of this seat's own moves is keyed by the turn number each entry of the log carries: an entry numbered
  // other than the turn the replay is at would escape them.
  logTurn: /^The log numbers the move made at turn (?<turn>-?\d+) as another turn$/,
  resultDiffers: 'Announced result differs from the replayed hand',
  scoresDiffer: 'Announced scores differ from the replayed hand',
  myHandDiffers: 'My final hand differs from the replay',
  shownStateMissing: /^The state this seat was shown at turn (?<turn>-?\d+) is not in the replay$/,
  // The hash covers tiles this seat may not see, so it cannot tell what the seat was shown: the view itself is held to
  // the replay too (an honest host sends exactly the replayed state's view for the seat).
  viewDiffers: /^The view of the table this seat was shown at turn (?<turn>-?\d+) is not the replayed one$/,
  // This seat's own moves and the moves made for it.
  legalMoveRefused: /^The host refused a legal move this seat made \(turn (?<turn>[^)]*)\)$/,
  moveChanged: /^The log changed a move this seat made \(turn (?<turn>[^)]*)\)$/,
  moveInvented: /^The log shows a move this seat never made \(turn (?<turn>[^)]*)\)$/,
  passedUpWin: /^The table played for this seat and passed up its win \(turn (?<turn>[^)]*)\)$/,
  playedEarly: /^The table played for this seat while it was connected and its clock had not run out \(turn (?<turn>[^)]*)\)$/,
  heldFrame: /^The host held back its frames on a link that stayed open, then played for this seat \(turn (?<turn>[^)]*)\)$/,
  lateTurn: /^The host showed this seat its turn late, on a link that stayed open \(turn (?<turn>[^)]*)\)$/,
  playedWhileDown: /^The table played for this seat while its connection was down, before its clock could have run out \(turn (?<turn>[^)]*)\)$/,
  bankTaken: /^The table took time from this seat's time bank while its connection was down \(turn (?<turn>[^)]*)\)$/,
  moveIgnored: /^The table ignored a move this seat sent in good time and played its own instead \(turn (?<turn>[^)]*)\)$/,
  // A legal move of this seat that the table neither played nor refused with that move's turn, followed on the same
  // connection by another move of the seat played at that turn: an honest host answers every move in the order it came.
  moveDropped: /^The table left a move this seat sent unanswered and played another of its moves in its place \(turn (?<turn>[^)]*)\)$/,
  tableMoveDiffers: /^The table played for this seat a move other than the one its published rule gives \(turn (?<turn>[^)]*)\)$/,
  // The moves the table made for the other seats.
  botMoveDiffers: /^The bot in seat (?<seat>-?\d+) played a move other than the one its published rule gives \(turn (?<turn>[^)]*)\)$/,
  seatMoveDiffers: /^The table played for seat (?<seat>-?\d+) a move that neither of its published rules gives \(turn (?<turn>[^)]*)\)$/,
  // The account of how many times the deal was tried, and why.
  attemptsMissing: 'Audit does not say how many ceremonies were run',
  restartsMissing: 'Audit does not list the ceremony restarts',
  restartCount: /^Audit lists (?<restarts>-?\d+) restarts for (?<attempts>-?\d+) ceremony attempts$/,
  tooManyAttempts: /^(?<attempts>-?\d+) ceremony attempts is more than (?<most>-?\d+), the most an honest table with (?<humans>-?\d+) human seats needs$/,
  restartMalformed: /^Restart (?<n>-?\d+) is malformed$/,
  restartBadSeat: /^Restart (?<n>-?\d+) names seat (?<seat>[\s\S]*), which is not a player seat$/,
  restartBlamesBot: /^Restart (?<n>-?\d+) blames seat (?<seat>-?\d+), which is a bot$/,
  restartBlamesAgain: /^Restart (?<n>-?\d+) blames seat (?<seat>-?\d+) again after the host had stood it in$/,
  attemptsBelowSeen: /^Audit reports (?<attempts>-?\d+) ceremony attempts but this seat was asked to commit in attempt (?<seen>-?\d+)$/,
  attemptsNotSeen: /^Audit reports (?<attempts>-?\d+) ceremony attempts but this seat was asked to commit (?<times>-?\d+) times$/,
  restartBlamesNoOne: /^Restart (?<n>-?\d+) blames no seat, yet this seat saw every attempt without losing its link$/,
  restartBlamesMeStoodIn: /^Restart (?<n>-?\d+) blames this seat although the host had stood it in$/,
  restartBlamesMeRevealed: /^Restart (?<n>-?\d+) blames this seat although it revealed, and the host then asked it for a new share instead of standing it in$/,
  blamedButUsed: 'The audit blames this seat for a restart, yet the deal used a new share from it instead of standing it in',
} as const satisfies Record<string, string | RegExp>;

export type AuditFailure = keyof typeof AUDIT_FAILURES;

/**
 * The key of a failure text produced by this client and the values it carries (a turn, a seat, a
 * count: always as text), or null for any other text.
 */
export function auditFailure(text: string): { key: AuditFailure; params: Record<string, string> } | null {
  for (const [k, v] of Object.entries(AUDIT_FAILURES) as Array<[AuditFailure, string | RegExp]>) {
    if (typeof v === 'string') {
      if (v === text) return { key: k, params: {} };
      continue;
    }
    const m = v.exec(text);
    if (m) return { key: k, params: { ...(m.groups ?? {}) } };
  }
  return null;
}

/** The key of a failure text produced by this client, or null for any other text. */
export function failureKey(text: string): AuditFailure | null {
  return auditFailure(text)?.key ?? null;
}

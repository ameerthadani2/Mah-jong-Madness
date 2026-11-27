import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AUDIT_CAVEATS, type Audit, type AuditStatus, type ClientState } from '@mjm/net';
import { FairnessScreen } from './FairnessScreen';
import type { Session } from '../game/session';
import { FakeProviders } from '../test/providers';
import { setLocalePreference } from '../i18n';
import { colors } from '../theme';
import { unjoined } from '../logic/keepWhole';

type AuditEntry = ClientState['audits'][number];

const hex = (c: string) => c.repeat(64);

/** A hand's audit as the table publishes it: five commitments (seat 4 is the server's), their secrets, a short log. */
function audit(handNumber: number): Audit {
  return {
    matchId: 'm-1',
    handNumber,
    seed: `seed-${handNumber}`,
    commits: [0, 1, 2, 3, 4].map((seat) => ({ seat, hash: hex(String(seat + 1)) })),
    reveals: [0, 1, 2, 3, 4].map((seat) => ({ seat, secret: hex(String.fromCharCode(97 + seat)) })),
    log: [],
    finalHash: `final-${handNumber}`,
    rngVersion: 'v1',
    ceremonyAttempts: 1,
    restarts: [],
    restartReasons: [],
  };
}

const entry = (handNumber: number, status: AuditStatus, o: { failures?: string[]; caveats?: string[] } = {}): AuditEntry => ({ audit: audit(handNumber), status, failures: o.failures ?? [], caveats: o.caveats ?? [] });

/** The three hands of a match as the table client judged them: hand 1 verified, hand 2 amber, hand 3 red. */
const HANDS: AuditEntry[] = [
  entry(0, 'ok'),
  entry(1, 'partial', { caveats: [AUDIT_CAVEATS.standIn, AUDIT_CAVEATS.tableMoved] }),
  // The sentences exactly as the client writes them, one the app knows by key and one it does not.
  entry(2, 'failed', { failures: ['The table played for this seat and passed up its win (turn 12)', 'Seed was not derived from the revealed secrets', 'A check this build does not know yet'] }),
];

/** Three claims the table passed for this seat while its link was down, over the match. */
const PASSED: ClientState['claimsPassedAway'] = [
  { hand: 1, turn: 9, claim: 'pong' },
  { hand: 1, turn: 21, claim: 'chow' },
  { hand: 2, turn: 4, claim: 'kong' },
];

/**
 * A stand-in for a table session: the client state the screen reads, and the change feed it listens to (`session.onChange`),
 * which the test drives to show the screen keeping up with the table.
 */
function fakeSession(state: Partial<ClientState>, mode: 'local' | 'online' = 'online') {
  const listeners = new Set<(s: ClientState) => void>();
  const full = { audits: [], claimsPassedAway: [], turnsShownLate: [], matchOver: false, matchEndVerified: false, auditCaveats: [], ...state } as unknown as ClientState;
  const session = {
    mode,
    host: null,
    client: { state: full },
    onChange: (cb: (s: ClientState) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as Session;
  const push = (next: Partial<ClientState>) => act(() => listeners.forEach((cb) => cb({ ...full, ...next } as ClientState)));
  return { session, push };
}

let backs = 0;
async function renderFairness(session: Session | null) {
  await render(
    <FakeProviders app={{ screen: { name: 'fairness' }, session, back: () => void backs++ }}>
      <FairnessScreen />
    </FakeProviders>,
  );
}

beforeEach(async () => {
  backs = 0;
  await AsyncStorage.clear();
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
});
afterEach(() => {
  setLocalePreference('auto');
});

describe('the fair play screen', () => {
  it('says no hand has finished before the first audit, and goes back from its header', async () => {
    await renderFairness(null);
    expect(screen.getByText('No hands finished yet.')).toBeOnTheScreen();
    expect(screen.queryByTestId('fairness-claims-passed')).toBeNull();
    expect(screen.queryByTestId('fairness-end-unverified')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(backs).toBe(1);
  });

  it('shows each hand newest first with its verdict, and the reasons for an amber and a red hand', async () => {
    await renderFairness(fakeSession({ audits: HANDS }).session);
    const titles = screen.getAllByText(/^Hand \d$/).map((n) => n.props.children);
    expect(titles).toEqual(['Hand 3', 'Hand 2', 'Hand 1']);
    // Each hand's verdict, in the same order (the first is the explanation of amber above the hands).
    const verdicts = screen.getAllByText(/^(Verified|Failed|Logged — the server could have picked this deal)$/).map((n) => n.props.children);
    expect(verdicts).toEqual(['Logged — the server could have picked this deal', 'Failed', 'Logged — the server could have picked this deal', 'Verified']);
    // The amber hand's reasons, in the player's words rather than the client's.
    expect(screen.getByText("The server made this seat's secret (it was late or away), so it could have picked this deal.")).toBeOnTheScreen();
    expect(screen.getByText(/^The table played for you while your connection was down\./)).toBeOnTheScreen();
    // The red hand's: the turn the client named is carried over, and a sentence with no key is shown as it came.
    expect(screen.getByText('The table played for you and passed up your win (turn 12).')).toBeOnTheScreen();
    expect(screen.getByText('The shuffle seed was not made from the revealed secrets.')).toBeOnTheScreen();
    expect(screen.getByText('A check this build does not know yet')).toBeOnTheScreen();
    expect(screen.queryByText(/passed up its win/)).toBeNull();
    // Each hand's evidence: the seed, every commitment with the start of its secret, the server's share named as such.
    expect(screen.getByText('seed seed-2')).toBeOnTheScreen();
    expect(screen.getAllByText(`seat 1 commit ${hex('1').slice(0, 16)}… secret ${hex('a').slice(0, 8)}…`)).toHaveLength(3);
    expect(screen.getAllByText(`server commit ${hex('5').slice(0, 16)}… secret ${hex('e').slice(0, 8)}…`)).toHaveLength(3);
    expect(screen.getByText('0 actions · final hash final-2')).toBeOnTheScreen();
    expect(screen.queryByText('No hands finished yet.')).toBeNull();
    expect(screen.queryByTestId('fairness-local')).toBeNull();
  });

  it('counts the claims the table passed up while the connection was down, and keeps the count as the match goes on', async () => {
    const { session, push } = fakeSession({ audits: HANDS, claimsPassedAway: PASSED });
    await renderFairness(session);
    expect(screen.getByTestId('fairness-claims-passed')).toHaveTextContent(/^In this match the table has passed up 3 claims \(Pong, Chow or Kong\) for you while your connection was down\./);
    await push({ audits: HANDS, claimsPassedAway: PASSED.slice(0, 1) });
    expect(screen.getByTestId('fairness-claims-passed')).toHaveTextContent(/^In this match the table has passed up 1 claim \(Pong, Chow or Kong\)/);
    await push({ audits: HANDS, claimsPassedAway: [] });
    expect(screen.queryByTestId('fairness-claims-passed')).toBeNull();
  });

  it('counts apart the claims passed on turns that reached the phone late, and does not say the connection was down for them', async () => {
    const late: ClientState['claimsPassedAway'] = [
      { hand: 1, turn: 33, claim: 'pong', late: true },
      { hand: 2, turn: 17, claim: 'chow', late: true },
    ];
    const { session, push } = fakeSession({ audits: HANDS, claimsPassedAway: [...PASSED.slice(0, 1), ...late] });
    await renderFairness(session);
    expect(screen.getByTestId('fairness-claims-passed')).toHaveTextContent(/^In this match the table has passed up 1 claim \(Pong, Chow or Kong\) for you while your connection was down\./);
    expect(screen.getByTestId('fairness-claims-passed-late')).toHaveTextContent(/^In this match the table has passed up 2 claims \(Pong, Chow or Kong\) for you on turns that reached your phone late\./);
    expect(screen.getByTestId('fairness-claims-passed-late')).not.toHaveTextContent(/connection was down/);
    // Only late ones: no sentence about a dropped connection at all.
    await push({ audits: HANDS, claimsPassedAway: late.slice(0, 1) });
    expect(screen.queryByTestId('fairness-claims-passed')).toBeNull();
    expect(screen.getByTestId('fairness-claims-passed-late')).toHaveTextContent(/^In this match the table has passed up 1 claim \(Pong, Chow or Kong\) for you on a turn that reached your phone late\./);
    // A hand's reason for a turn shown late names it as such.
    await push({ audits: [entry(0, 'partial', { caveats: [AUDIT_CAVEATS.tableMovedLate, AUDIT_CAVEATS.passedPongLate] })], claimsPassedAway: late.slice(0, 1) });
    expect(screen.getByText(/^The table played for you on a turn that reached your phone late, so your phone did not see that turn in time\./)).toBeOnTheScreen();
    expect(screen.getByText(/^On a turn that reached your phone late, the table passed up a Pong you could have made\./)).toBeOnTheScreen();
    expect(screen.queryByText(/while your connection was down/)).toBeNull();
  });

  it('counts the turns that reached the phone late out of those it measured, and keeps the count as the match goes on', async () => {
    const { session, push } = fakeSession({ audits: HANDS, turnsShownLate: [{ hand: 0, late: [], of: 22 }] });
    await renderFairness(session);
    // None late: nothing said.
    expect(screen.queryByTestId('fairness-turns-late')).toBeNull();
    await push({ audits: HANDS, turnsShownLate: [{ hand: 0, late: [], of: 22 }, { hand: 1, late: [3, 7, 12], of: 19 }] });
    expect(screen.getByTestId('fairness-turns-late')).toHaveTextContent(/^In this match 3 of your 41 turns reached you late: more than a quarter of their turn clock \(at least 1 second\) was gone by the time your phone showed them\./);
    expect(screen.getByTestId('fairness-turns-late')).toHaveTextContent(/A hand stops showing Verified when a turn reaches you more than half its turn clock late \(at least 2 seconds\)/);
    await push({ audits: HANDS, turnsShownLate: [{ hand: 1, late: [3], of: 19 }] });
    expect(screen.getByTestId('fairness-turns-late')).toHaveTextContent(/^In this match 1 of your 19 turns reached you late: more than a quarter of its turn clock \(at least 1 second\) was gone/);
  });

  it('says when the final scores of a finished match are the table word alone', async () => {
    const { session, push } = fakeSession({ audits: HANDS, matchOver: true, matchEndVerified: true });
    await renderFairness(session);
    expect(screen.queryByTestId('fairness-end-unverified')).toBeNull();
    await push({ audits: HANDS, matchOver: true, matchEndVerified: false });
    expect(screen.getByTestId('fairness-end-unverified')).toHaveTextContent(/^The match is over, but your phone could not check the final scores/);
  });

  it('says when a hand of the match failed its check: the final scores are not shown as verified, in red, whatever else the end says', async () => {
    const { session, push } = fakeSession({ audits: HANDS, matchOver: true, matchEndVerified: true, matchFailed: false });
    await renderFairness(session);
    expect(screen.queryByTestId('fairness-end-unverified')).toBeNull();
    await push({ audits: HANDS, matchOver: true, matchEndVerified: false, matchFailed: true });
    expect(screen.getByTestId('fairness-end-unverified')).toHaveTextContent(/^The match is over, but its final scores are not shown as verified: a hand of this match failed its check/);
    expect(screen.getByTestId('fairness-end-unverified')).toHaveStyle({ color: colors.dangerText });
    // Not the note for a phone that could not follow the match: this one caught the table out.
    expect(screen.getByTestId('fairness-end-unverified')).not.toHaveTextContent(/could not check the final scores/);
  });

  it('says the same in Traditional Chinese', async () => {
    setLocalePreference('zh-TW');
    await renderFairness(fakeSession({ audits: HANDS, matchOver: true, matchEndVerified: false, matchFailed: true }).session);
    expect(screen.getByTestId('fairness-end-unverified')).toHaveTextContent(/^比賽已經結束，但最終分數不算核對過：這場比賽有一局沒有通過檢查/);
  });

  it('against bots, says the phone deals and checks itself, and calls the fifth share the table', async () => {
    await renderFairness(fakeSession({ audits: [HANDS[0]] }, 'local').session);
    expect(screen.getByTestId('fairness-local')).toBeOnTheScreen();
    expect(screen.queryByText(/^server commit/)).toBeNull();
    expect(screen.getByText(/ commit 5555555555555555… secret eeeeeeee…$/)).toBeOnTheScreen();
  });

  it('speaks Traditional Chinese, the reasons and the count included', async () => {
    setLocalePreference('zh-TW');
    await renderFairness(fakeSession({ audits: HANDS, claimsPassedAway: PASSED }).session);
    // Drawn with a no-break space between a number and its unit (src/logic/keepWhole.ts).
    expect(screen.getAllByText(/^第 \d 局$/).map((n) => unjoined(n.props.children))).toEqual(['第 3 局', '第 2 局', '第 1 局']);
    expect(screen.getAllByText(/^(已驗證|驗證失敗|已記錄——這副牌可能是伺服器挑的)$/).map((n) => unjoined(n.props.children))).toEqual(['已記錄——這副牌可能是伺服器挑的', '驗證失敗', '已記錄——這副牌可能是伺服器挑的', '已驗證']);
    expect(screen.getByText('伺服器替這個位子產生了祕密（太慢或不在線上），所以這副牌可能是它挑的。')).toBeOnTheScreen();
    expect(screen.getByText('牌桌替你出牌，卻放掉了你可以胡的牌（第 12 手）。')).toBeOnTheScreen();
    expect(screen.getByText('洗牌種子不是用公開的祕密算出來的。')).toBeOnTheScreen();
    expect(screen.getByTestId('fairness-claims-passed')).toHaveTextContent(/^這場比賽中，你斷線時牌桌替你放棄了 3 次吃、碰或槓。/);
    expect(screen.getAllByText(/^伺服器 承諾 /)).toHaveLength(3);
  });

  it('speaks Traditional Chinese for the count of turns that reached the phone late', async () => {
    setLocalePreference('zh-TW');
    await renderFairness(fakeSession({ audits: HANDS, turnsShownLate: [{ hand: 0, late: [2, 5], of: 30 }] }).session);
    expect(screen.getByTestId('fairness-turns-late')).toHaveTextContent(/^這場比賽中，輪到你的 30 手裡，有 2 手晚到：等你的手機顯示出來時，每手秒數已經過了四分之一以上（至少 1 秒）。/);
    expect(screen.getByTestId('fairness-turns-late')).toHaveTextContent(/某一手晚到超過每手秒數的一半（至少 2 秒）時，牌局就不會顯示「已驗證」/);
  });

  it('speaks Traditional Chinese for a turn that reached the phone late, and does not say the connection dropped', async () => {
    setLocalePreference('zh-TW');
    const late: ClientState['claimsPassedAway'] = [{ hand: 0, turn: 33, claim: 'kong', late: true }];
    await renderFairness(fakeSession({ audits: [entry(0, 'partial', { caveats: [AUDIT_CAVEATS.tableMovedLate, AUDIT_CAVEATS.passedKongLate] })], claimsPassedAway: late }).session);
    expect(screen.queryByTestId('fairness-claims-passed')).toBeNull();
    expect(screen.getByTestId('fairness-claims-passed-late')).toHaveTextContent(/^這場比賽中，有幾手輪到你的牌比較晚才送到你的手機，牌桌在那幾手替你放棄了 1 次吃、碰或槓。/);
    expect(screen.getByText(/^輪到你的某一手比較晚才送到你的手機，牌桌在那一手替你出了牌/)).toBeOnTheScreen();
    expect(screen.getByText(/^輪到你的某一手比較晚才送到你的手機，牌桌在那一手替你放棄了一次可以槓的牌。/)).toBeOnTheScreen();
    expect(screen.queryByText(/斷線/)).toBeNull();
  });
});

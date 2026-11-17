import { afterEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { ClosedMatch } from '../api/clubs';
import { setLocalePreference } from '../i18n';
import { ClubClosedMatches } from './ClubClosedMatches';

const closed = (table: string, label: string, closedAt: number, hand: number): ClosedMatch => ({
  table,
  label,
  closedAt,
  closedBy: { userId: 'u-owner', name: 'Owner' },
  handNumber: hand,
  seats: [
    { seat: 0, name: 'Owner', userId: 'u-owner', isBot: false, points: 0 },
    { seat: 1, name: 'Alice', userId: 'u-alice', isBot: false, points: 140 },
    { seat: 2, name: 'Bot', isBot: true, points: 0 },
    { seat: 3, name: 'Bot', isBot: true, points: -140 },
  ],
});
const at = Date.UTC(2026, 10, 12, 9);

describe("the club's closed matches, as a member sees them under the standings", () => {
  afterEach(() => setLocalePreference('auto'));

  it('shows who closed each match, in which hand, and the points at closure, newest first, and says they do not count', async () => {
    setLocalePreference('en');
    await render(<ClubClosedMatches matches={[closed('ROOM01', 'Friday', at, 1), closed('ROOM02', 'Late', at + 86_400_000, 4)]} />);
    expect(screen.getByText('Closed before the end')).toBeTruthy();
    expect(screen.getByText(/They do not count toward the standings/)).toBeTruthy();
    const date = new Date(at).toLocaleDateString();
    expect(screen.getByText(`Friday: closed by Owner in hand 2, ${date}`)).toBeTruthy();
    expect(screen.getAllByText('Owner 0 · Alice +140 · Bot (bot) 0 · Bot (bot) -140')).toHaveLength(2);
    const order = screen.getAllByTestId(/^closed-/).map((n) => n.props.testID);
    expect(order).toEqual(['closed-ROOM02', 'closed-ROOM01']);
  });

  it('reads in Traditional Chinese', async () => {
    setLocalePreference('zh-TW');
    await render(<ClubClosedMatches matches={[closed('ROOM01', 'Friday', at, 1)]} />);
    expect(screen.getByText('中途結束的牌局')).toBeTruthy();
    expect(screen.getByText(`Friday：Owner在第 2 局關閉，${new Date(at).toLocaleDateString()}`)).toBeTruthy();
    expect(screen.getByText('Owner 0 · Alice +140 · Bot（電腦） 0 · Bot（電腦） -140')).toBeTruthy();
  });

  it('shows nothing when no match was closed', async () => {
    await render(<ClubClosedMatches matches={undefined} />);
    expect(screen.queryByTestId('club-closed-matches')).toBeNull();
  });
});

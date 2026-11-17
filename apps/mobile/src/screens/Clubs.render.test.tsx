import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { DEFAULT_RULES } from '@mjm/engine';
import { ClubScreen, ClubsScreen } from './ClubsScreen';
import { clubsApi, PENDING_POLL_MS, type Club, type ClubListing, type ClubMember } from '../api/clubs';
import { FakeProviders, sessionClient } from '../test/providers';
import { RemoteConfigProvider } from '../telemetry/RemoteConfig';
import type { AppState } from '../app-state';
import type { AuthContextValue } from '../auth/AuthProvider';

const ME = 'u-me';
const member = (userId: string, name: string, role: ClubMember['role'], points = 0): ClubMember => ({ userId, name, role, joinedAt: 0, points, seasonPoints: points, lifetimePoints: points, matchesPlayed: 1, matchesWon: 0 }) as ClubMember;

/** The member's view of a club with one table in play, as the server sends it. */
function club(role: ClubMember['role'] | null, extra: Partial<Club> = {}): ClubListing {
  const members = [member('u-owner', 'Owner', 'owner', 40), member('u-alice', 'Alice', 'member', -40), ...(role && role !== 'owner' ? [member(ME, 'Mei', role)] : [])];
  if (role === 'owner') members[0] = member(ME, 'Mei', 'owner', 40);
  return {
    code: 'AB12',
    name: 'Friday Club',
    description: '',
    ownerId: role === 'owner' ? ME : 'u-owner',
    season: 1,
    rules: DEFAULT_RULES,
    settings: { membersCanOpenTables: true, joinRequiresApproval: false },
    members,
    pending: [],
    tables: [
      {
        code: 'T1',
        label: "Alice's table",
        rules: DEFAULT_RULES,
        createdBy: 'u-alice',
        createdAt: 0,
        status: 'playing',
        handNumber: 2,
        scores: [0, 0, 0, 0],
        players: [
          { seat: 0, name: 'Alice', userId: 'u-alice', isBot: false, connected: true },
          { seat: 1, name: 'Bot', isBot: true, connected: true },
          { seat: 2, name: 'Bot', isBot: true, connected: true },
          { seat: 3, name: 'Bot', isBot: true, connected: true },
        ],
      },
    ],
    ...extra,
  };
}
/** What a player who is not a member is sent: no rules, settings, members or tables. */
const publicView = (approval: boolean): ClubListing => ({ code: 'AB12', name: 'Friday Club', description: '', memberCount: 2, joinRequiresApproval: approval });

let storeEnabled = false;
beforeEach(async () => {
  await AsyncStorage.clear();
  // An adult who answered the age gate: the online screens ask before anything reaches the server.
  await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
  storeEnabled = false;
  // The stand-in network answers the remote config and nothing else (every club call is a spy below).
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) =>
    url.endsWith('/api/config')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ authProviders: [], storeEnabled, pushEnabled: false, minBuild: 0, maintenance: null }) }
      : { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not_found' }) },
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

const signedIn: Partial<AuthContextValue> = { status: 'guest', user: { id: ME } as AuthContextValue['user'], client: sessionClient(ME), ensure: async () => true };

async function renderList(app: Partial<AppState> = {}) {
  const go = jest.fn();
  await render(
    <FakeProviders app={{ go, screen: { name: 'clubs' }, ...app }} auth={signedIn}>
      <RemoteConfigProvider>
        <ClubsScreen />
      </RemoteConfigProvider>
    </FakeProviders>,
  );
  return { go };
}

async function renderClub(listing: ClubListing) {
  jest.spyOn(clubsApi, 'get').mockResolvedValue(listing as Club);
  const back = jest.fn();
  await render(
    <FakeProviders app={{ back, screen: { name: 'club', code: 'AB12' } }} auth={signedIn}>
      <ClubScreen code="AB12" />
    </FakeProviders>,
  );
  await screen.findByText('Friday Club');
  return { back };
}

describe('the Clubs list', () => {
  it('lists my clubs with my role, and a club I only asked to join as pending, with no way in yet', async () => {
    jest.spyOn(clubsApi, 'mine').mockResolvedValue([club('member'), { ...publicView(true), code: 'CD34', name: 'Waiting Club' }]);
    const { go } = await renderList();
    expect(await screen.findByText('Waiting Club')).toBeOnTheScreen();
    expect(screen.getByText('Pending approval')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Open Waiting Club' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Open Friday Club' }));
    expect(go).toHaveBeenCalledWith({ name: 'club', code: 'AB12' });
  });

  it('says so when the player is in no club', async () => {
    jest.spyOn(clubsApi, 'mine').mockResolvedValue([]);
    await renderList();
    expect(await screen.findByText('You are not in any club yet.')).toBeOnTheScreen();
  });

  it('sends a join request for the typed code and says an admin must approve it', async () => {
    jest.spyOn(clubsApi, 'mine').mockResolvedValue([]);
    const join = jest.spyOn(clubsApi, 'join').mockResolvedValue({ club: club('member') as Club, status: 'pending' });
    await renderList();
    await screen.findByText('You are not in any club yet.');
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
    await fireEvent.changeText(screen.getByPlaceholderText('CLUB CODE'), 'ab12');
    await fireEvent.press(screen.getByRole('button', { name: 'Join' }));
    expect(join).toHaveBeenCalledWith(expect.anything(), 'AB12');
    expect(await screen.findByText('Request sent — an admin must approve you.')).toBeOnTheScreen();
  });

  it('lets anyone create a club while the store is not live', async () => {
    jest.spyOn(clubsApi, 'mine').mockResolvedValue([]);
    const create = jest.spyOn(clubsApi, 'create').mockResolvedValue(club('owner') as Club);
    const { go } = await renderList();
    await screen.findByText('You are not in any club yet.');
    expect(screen.queryByTestId('club-fourwinds-offer')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'New club' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await fireEvent.changeText(screen.getByPlaceholderText('Club name'), 'Friday Club');
    await fireEvent.press(screen.getByRole('switch', { name: 'Approve members before they join' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create' }));
    expect(create).toHaveBeenCalledWith(expect.anything(), 'Friday Club', expect.any(Object), { joinRequiresApproval: true });
    await waitFor(() => expect(go).toHaveBeenCalledWith({ name: 'club', code: 'AB12' }));
  });

  it('offers The Four Winds Club instead of the create form to a non-subscriber once the store is live', async () => {
    storeEnabled = true;
    jest.spyOn(clubsApi, 'mine').mockResolvedValue([]);
    const { go } = await renderList();
    expect(await screen.findByTestId('club-fourwinds-offer')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'New club' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'See The Four Winds Club' }));
    expect(go).toHaveBeenCalledWith({ name: 'shop', focus: 'fourwinds' });
    // Joining stays free.
    expect(screen.getByText('Join a club')).toBeOnTheScreen();
  });
});

describe('a club seen by a player who is not a member', () => {
  it('shows one card with the way in, and none of the tabs', async () => {
    await renderClub(publicView(false));
    expect(screen.getByTestId('club-join-card')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Tables/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rules' })).toBeNull();
  });

  it('asks to join a club that approves its members, and says the request was sent', async () => {
    const join = jest.spyOn(clubsApi, 'join').mockResolvedValue({ club: publicView(true) as Club, status: 'pending' });
    await renderClub(publicView(true));
    await fireEvent.press(screen.getByRole('button', { name: 'Ask to join' }));
    expect(join).toHaveBeenCalledWith(expect.anything(), 'AB12');
    expect(await screen.findByTestId('club-join-asked')).toHaveTextContent('Request sent. The club appears under My clubs once an admin approves you.');
  });
});

describe('owner tools', () => {
  it('are not shown to a plain member', async () => {
    await renderClub(club('member', { pending: [{ userId: 'u-new', name: 'Newcomer' }] }));
    expect(screen.getByRole('button', { name: 'Join table' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Close table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open a variant table' })).toBeNull();
    expect(screen.queryByText('Pending requests')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Members (3)' }));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
    expect(screen.queryByText('Banned')).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave club' })).toBeOnTheScreen();
  });

  it('let an admin close a table, after asking first', async () => {
    const close = jest.spyOn(clubsApi, 'closeTable').mockResolvedValue(club('admin', { tables: [] }) as never);
    await renderClub(club('admin'));
    await fireEvent.press(screen.getByRole('button', { name: 'Close table' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId('club-confirm')).toHaveTextContent(/^Close Alice's table\? The match ends now and counts for nothing\./);
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(close).toHaveBeenCalledWith(expect.anything(), 'AB12', 'T1');
    expect(await screen.findByText('Table closed.')).toBeOnTheScreen();
  });

  it('let an admin answer a join request', async () => {
    const approve = jest.spyOn(clubsApi, 'approve').mockResolvedValue(club('admin') as never);
    await renderClub(club('admin', { pending: [{ userId: 'u-new', name: 'Newcomer' }] }));
    expect(screen.getByText('Pending requests')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith(expect.anything(), 'AB12', 'u-new');
  });

  it('give the owner the member tools, and only a confirmed removal reaches the server', async () => {
    const remove = jest.spyOn(clubsApi, 'remove').mockResolvedValue(club('owner') as never);
    await renderClub(club('owner'));
    await fireEvent.press(screen.getByRole('button', { name: 'Members (2)' }));
    const alice = screen.getByText('Alice');
    expect(alice).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Make admin' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Make owner' })).toBeOnTheScreen();
    expect(screen.getByText('Banned')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Delete club' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Leave club' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.press(within(screen.getByTestId('club-confirm')).getByRole('button', { name: 'Confirm' }));
    expect(remove).toHaveBeenCalledWith(expect.anything(), 'AB12', 'u-alice');
  });
});

describe('the standings', () => {
  it('show the closed-match record under the standings, and only the owner may start a season', async () => {
    const closedMatches = [{ table: 'T0', label: 'Late', closedAt: Date.UTC(2026, 10, 12), closedBy: { userId: 'u-owner', name: 'Owner' }, handNumber: 3, seats: [{ seat: 0, name: 'Alice', userId: 'u-alice', isBot: false, points: 20 }] }];
    await renderClub(club('member', { closedMatches }));
    await fireEvent.press(screen.getByRole('button', { name: 'Standings' }));
    expect(screen.getByTestId('club-closed-matches')).toBeOnTheScreen();
    expect(screen.getByText(/^Late: closed by Owner in hand 4/)).toBeOnTheScreen();
    expect(screen.queryByTestId('season-start')).toBeNull();
  });
});

describe('reading a club again', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('tells a member who was removed since why the screen changed', async () => {
    jest.useFakeTimers();
    jest.spyOn(clubsApi, 'get').mockResolvedValueOnce(club('member') as Club).mockResolvedValue(publicView(false) as Club);
    await render(
      <FakeProviders app={{ screen: { name: 'club', code: 'AB12' } }} auth={signedIn}>
        <ClubScreen code="AB12" />
      </FakeProviders>,
    );
    expect(await screen.findByRole('button', { name: 'Join table' })).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(await screen.findByTestId('club-removed')).toHaveTextContent('You are no longer a member of this club.');
    expect(screen.getByTestId('club-join-card')).toBeOnTheScreen();
  });

  it('looks at My clubs again while a request to join is waiting, and not otherwise', async () => {
    jest.useFakeTimers();
    const mine = jest.spyOn(clubsApi, 'mine').mockResolvedValue([{ ...publicView(true), code: 'CD34', name: 'Waiting Club' }]);
    await renderList();
    await screen.findByText('Waiting Club');
    const before = mine.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(PENDING_POLL_MS);
    });
    expect(mine.mock.calls.length).toBe(before + 1);
    // Approved: the club comes back as the member's view, and the list is no longer polled.
    mine.mockResolvedValue([club('member')]);
    await act(async () => {
      jest.advanceTimersByTime(PENDING_POLL_MS);
    });
    await screen.findByRole('button', { name: 'Open Friday Club' });
    const settled = mine.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(PENDING_POLL_MS * 3);
    });
    expect(mine.mock.calls.length).toBe(settled);
  });
});

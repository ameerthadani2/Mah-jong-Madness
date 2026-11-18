/**
 * Postgres repositories for clubs (members, tables, bans, former members, seasons) and their per-address and per-device join allowances.
 * Part of the Postgres repositories that createPgRepos (pg.ts) assembles; the rules in pg.ts apply here too.
 */
import { anonymiseUserIn, moveMembershipsIn, type Club, type ClubBan, type ClubMember, type ClubSettings, type ClosedMatch, type ClubTable, type FormerMember, type Identity, type OwnerLapse, type SeasonRecord } from '../clubs';
import type { Queryable } from '../db';
import {
  type ClubMembership,
  type ClubsRepo,
  type JoinAllowanceRecord,
  type JoinAllowancesRepo,
  type JoinHourRecord,
} from './types';
import { type Tx, isUuid, toDate, json } from './pgShared';

interface ClubRow {
  code: string;
  owner_id: string;
  name: string;
  description: string;
  rules: Club['rules'];
  settings: ClubSettings;
  created_at: Date;
  season: number;
  season_started_at: Date | null;
  season_history: SeasonRecord[] | null;
  owner_lapsed_at: Date | null;
  owner_lapses: OwnerLapse[] | null;
  closed_matches: ClosedMatch[] | null;
}
interface BanRow {
  club_code: string;
  user_id: string;
  display_name: string;
  banned_by: string;
  banned_at: Date;
}
interface MemberRow {
  club_code: string;
  user_id: string;
  role: ClubMember['role'];
  status: 'member' | 'pending';
  display_name: string;
  avatar: string | null;
  joined_at: Date;
  season_points: number;
  lifetime_points: number;
  matches_played: number;
  matches_won: number;
  hands_won: number;
  requested_at: Date | null;
}
interface TableRow {
  code: string;
  club_code: string;
  label: string;
  rules: ClubTable['rules'];
  created_by: string;
  status: ClubTable['status'];
  state: { players?: ClubTable['players']; handNumber?: number; scores?: number[]; startedWith?: ClubTable['startedWith']; membersToCount?: number };
  created_at: Date;
  variant: boolean;
}
interface FormerRow {
  club_code: string;
  user_id: string;
  left_at: Date;
  season: number;
  season_points: number;
  lifetime_points: number;
  matches_played: number;
  matches_won: number;
  hands_won: number;
}

function identityOf(r: MemberRow): Identity {
  return r.avatar === null ? { userId: r.user_id, name: r.display_name } : { userId: r.user_id, name: r.display_name, avatar: r.avatar };
}

function assembleClubs(clubs: ClubRow[], members: MemberRow[], tables: TableRow[], bans: BanRow[], former: FormerRow[]): Club[] {
  const byCode = new Map<string, Club>();
  for (const c of clubs) {
    // Newer fields are set only when there is something in them, so a club reads back as it was written.
    const lapses = Array.isArray(c.owner_lapses) && c.owner_lapses.length ? { ownerLapses: c.owner_lapses } : {};
    const closed = Array.isArray(c.closed_matches) && c.closed_matches.length ? { closedMatches: c.closed_matches } : {};
    byCode.set(c.code, {
      ...lapses,
      ...closed,
      code: c.code,
      name: c.name,
      description: c.description,
      ownerId: c.owner_id,
      createdAt: c.created_at.getTime(),
      rules: c.rules,
      settings: c.settings,
      members: [],
      pending: [],
      tables: [],
      season: c.season,
      seasonStartedAt: (c.season_started_at ?? c.created_at).getTime(),
      seasons: Array.isArray(c.season_history) ? c.season_history : [],
      bans: [],
      ownerLapsedAt: c.owner_lapsed_at ? c.owner_lapsed_at.getTime() : null,
    });
  }
  for (const b of bans) {
    const ban: ClubBan = { userId: b.user_id, name: b.display_name, bannedAt: b.banned_at.getTime(), by: b.banned_by };
    byCode.get(b.club_code)?.bans!.push(ban);
  }
  for (const m of members) {
    const club = byCode.get(m.club_code);
    if (!club) continue;
    if (m.status === 'pending') club.pending.push({ ...identityOf(m), ...(m.requested_at ? { requestedAt: m.requested_at.getTime() } : {}) });
    else
      club.members.push({
        ...identityOf(m),
        role: m.role,
        joinedAt: m.joined_at.getTime(),
        points: m.lifetime_points,
        seasonPoints: m.season_points,
        matchesPlayed: m.matches_played,
        matchesWon: m.matches_won,
        handsWon: m.hands_won,
      });
  }
  for (const t of tables) {
    const club = byCode.get(t.club_code);
    if (!club) continue;
    club.tables.push({
      code: t.code,
      label: t.label,
      rules: t.rules,
      createdBy: t.created_by,
      createdAt: t.created_at.getTime(),
      status: t.status,
      players: t.state.players ?? [],
      handNumber: t.state.handNumber ?? 0,
      scores: t.state.scores ?? [],
      variant: t.variant === true,
      ...(Array.isArray(t.state.startedWith) ? { startedWith: t.state.startedWith } : {}),
      ...(typeof t.state.membersToCount === 'number' ? { membersToCount: t.state.membersToCount } : {}),
    });
  }
  for (const f of former) {
    const club = byCode.get(f.club_code);
    if (!club) continue;
    const row: FormerMember = {
      userId: f.user_id,
      leftAt: f.left_at.getTime(),
      season: f.season,
      points: f.lifetime_points,
      seasonPoints: f.season_points,
      matchesPlayed: f.matches_played,
      matchesWon: f.matches_won,
      handsWon: f.hands_won,
    };
    (club.former ??= []).push(row);
  }
  return [...byCode.values()];
}

export function pgClubs(q: Queryable, tx: Tx): ClubsRepo {
  const CLUB_COLS = 'code, owner_id, name, description, rules, settings, created_at, season, season_started_at, season_history, owner_lapsed_at, owner_lapses, closed_matches';
  const MEMBER_COLS = 'club_code, user_id, role, status, display_name, avatar, joined_at, season_points, lifetime_points, matches_played, matches_won, hands_won, requested_at';
  const TABLE_COLS = 'code, club_code, label, rules, created_by, status, state, created_at, variant';
  const BAN_COLS = 'club_code, user_id, display_name, banned_by, banned_at';
  const FORMER_COLS = 'club_code, user_id, left_at, season, season_points, lifetime_points, matches_played, matches_won, hands_won';
  const load = async (c: Queryable, codes: string[] | null): Promise<Club[]> => {
    const clubs = await c.query<ClubRow>('SELECT ' + CLUB_COLS + ' FROM clubs WHERE ($1::text[] IS NULL OR code = ANY($1::text[])) ORDER BY created_at, code', [codes]);
    if (!clubs.rows.length) return [];
    const found = clubs.rows.map((r) => r.code);
    const members = await c.query<MemberRow>('SELECT ' + MEMBER_COLS + ' FROM club_members WHERE club_code = ANY($1::text[]) ORDER BY joined_at, user_id', [found]);
    const tables = await c.query<TableRow>('SELECT ' + TABLE_COLS + ' FROM club_tables WHERE club_code = ANY($1::text[]) ORDER BY created_at, code', [found]);
    const bans = await c.query<BanRow>('SELECT ' + BAN_COLS + ' FROM club_bans WHERE club_code = ANY($1::text[]) ORDER BY banned_at, user_id', [found]);
    const former = await c.query<FormerRow>('SELECT ' + FORMER_COLS + ' FROM club_former_members WHERE club_code = ANY($1::text[]) ORDER BY left_at, user_id', [found]);
    return assembleClubs(clubs.rows, members.rows, tables.rows, bans.rows, former.rows);
  };
  /**
   * Write one club in full on the given connection. The club in memory may name accounts that have
   * since been purged (their member rows went with them, see 0001_init): only rows whose user
   * still exists are written, and an owner that no longer exists leaves the stored owner as it is,
   * so a save never fails on a missing user. `club_tables.created_by`, `club_bans.user_id` and
   * `club_bans.banned_by` carry no foreign key.
   */
  const saveWith = async (c: Queryable, club: Club): Promise<void> => {
    const rows = [
      ...club.members.map((m) => ({
        user_id: m.userId,
        role: m.role,
        status: 'member',
        display_name: m.name,
        avatar: m.avatar ?? null,
        joined_at: m.joinedAt,
        points: m.points,
        season_points: m.seasonPoints ?? m.points,
        matches_played: m.matchesPlayed,
        matches_won: m.matchesWon,
        hands_won: m.handsWon,
        requested_at: null as number | null,
      })),
      ...club.pending.map((p) => ({
        user_id: p.userId,
        role: 'member',
        status: 'pending',
        display_name: p.name,
        avatar: p.avatar ?? null,
        joined_at: null,
        points: 0,
        season_points: 0,
        matches_played: 0,
        matches_won: 0,
        hands_won: 0,
        requested_at: p.requestedAt ?? null,
      })),
    ];
    const tables = club.tables.map((t) => ({
      code: t.code,
      label: t.label,
      rules: t.rules,
      created_by: t.createdBy,
      status: t.status,
      state: { players: t.players, handNumber: t.handNumber, scores: t.scores, ...(t.startedWith ? { startedWith: t.startedWith } : {}), ...(t.membersToCount !== undefined ? { membersToCount: t.membersToCount } : {}) },
      created_at: t.createdAt,
      variant: t.variant === true,
    }));
    // Only ids that can be stored: a ban row's user_id is a uuid (accounts always are).
    const bans = (club.bans ?? []).filter((b) => isUuid(b.userId)).map((b) => ({ user_id: b.userId, display_name: b.name, banned_by: b.by, banned_at: b.bannedAt }));
    const former = (club.former ?? [])
      .filter((f) => isUuid(f.userId))
      .map((f) => ({ user_id: f.userId, left_at: f.leftAt, season: f.season, season_points: f.seasonPoints, points: f.points, matches_played: f.matchesPlayed, matches_won: f.matchesWon, hands_won: f.handsWon }));
    await c.query(
      `INSERT INTO clubs (code, owner_id, name, description, rules, settings, created_at, updated_at, season, season_started_at, season_history, owner_lapsed_at, owner_lapses, closed_matches)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now(), $8, $9, $10::jsonb, $11, $12::jsonb, $13::jsonb)
       ON CONFLICT (code) DO UPDATE SET
         owner_id = CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = excluded.owner_id) THEN excluded.owner_id ELSE clubs.owner_id END,
         name = excluded.name, description = excluded.description,
         rules = excluded.rules, settings = excluded.settings, updated_at = now(), season = excluded.season,
         season_started_at = excluded.season_started_at, season_history = excluded.season_history, owner_lapsed_at = excluded.owner_lapsed_at,
         owner_lapses = excluded.owner_lapses, closed_matches = excluded.closed_matches`,
      [
        club.code,
        club.ownerId,
        club.name,
        club.description,
        json(club.rules),
        json(club.settings),
        toDate(club.createdAt),
        club.season ?? 1,
        toDate(club.seasonStartedAt ?? club.createdAt),
        json(club.seasons ?? []),
        typeof club.ownerLapsedAt === 'number' ? toDate(club.ownerLapsedAt) : null,
        json(club.ownerLapses ?? []),
        json(club.closedMatches ?? []),
      ],
    );
    await c.query('DELETE FROM club_members WHERE club_code = $1 AND NOT (user_id = ANY($2::uuid[]))', [club.code, rows.map((r) => r.user_id)]);
    await c.query(
      `INSERT INTO club_members (club_code, user_id, role, status, display_name, avatar, joined_at, season_points, lifetime_points, matches_played, matches_won, hands_won, requested_at)
       SELECT $1, r.user_id, r.role, r.status, r.display_name, r.avatar, COALESCE(to_timestamp(r.joined_at / 1000.0), now()),
              r.season_points, r.points, r.matches_played, r.matches_won, r.hands_won, to_timestamp(r.requested_at / 1000.0)
       FROM jsonb_to_recordset($2::jsonb) AS r(user_id uuid, role text, status text, display_name text, avatar text,
            joined_at double precision, season_points integer, points integer, matches_played integer, matches_won integer, hands_won integer,
            requested_at double precision)
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)
       ON CONFLICT (club_code, user_id) DO UPDATE SET role = excluded.role, status = excluded.status,
         display_name = excluded.display_name, avatar = excluded.avatar,
         joined_at = CASE WHEN excluded.status = 'member' THEN excluded.joined_at ELSE club_members.joined_at END,
         season_points = excluded.season_points, lifetime_points = excluded.lifetime_points, matches_played = excluded.matches_played,
         matches_won = excluded.matches_won, hands_won = excluded.hands_won, requested_at = excluded.requested_at`,
      [club.code, json(rows)],
    );
    await c.query('DELETE FROM club_tables WHERE club_code = $1 AND NOT (code = ANY($2::text[]))', [club.code, tables.map((t) => t.code)]);
    await c.query(
      `INSERT INTO club_tables (code, club_code, label, rules, created_by, status, state, created_at, finished_at, variant)
       SELECT r.code, $1, r.label, r.rules, r.created_by, r.status, r.state, to_timestamp(r.created_at / 1000.0),
              CASE WHEN r.status = 'finished' THEN now() END, COALESCE(r.variant, false)
       FROM jsonb_to_recordset($2::jsonb) AS r(code text, label text, rules jsonb, created_by text, status text, state jsonb, created_at double precision, variant boolean)
       ON CONFLICT (code) DO UPDATE SET club_code = excluded.club_code, label = excluded.label, rules = excluded.rules,
         created_by = excluded.created_by, status = excluded.status, state = excluded.state, variant = excluded.variant,
         finished_at = CASE WHEN excluded.status = 'finished' THEN COALESCE(club_tables.finished_at, now()) END`,
      [club.code, json(tables)],
    );
    await c.query('DELETE FROM club_bans WHERE club_code = $1 AND NOT (user_id = ANY($2::uuid[]))', [club.code, bans.map((b) => b.user_id)]);
    await c.query(
      `INSERT INTO club_bans (club_code, user_id, display_name, banned_by, banned_at)
       SELECT $1, r.user_id, r.display_name, r.banned_by, to_timestamp(r.banned_at / 1000.0)
       FROM jsonb_to_recordset($2::jsonb) AS r(user_id uuid, display_name text, banned_by text, banned_at double precision)
       ON CONFLICT (club_code, user_id) DO UPDATE SET display_name = excluded.display_name, banned_by = excluded.banned_by, banned_at = excluded.banned_at`,
      [club.code, json(bans)],
    );
    // Standings on file reference the account like a member row: only for users that still exist.
    await c.query('DELETE FROM club_former_members WHERE club_code = $1 AND NOT (user_id = ANY($2::uuid[]))', [club.code, former.map((f) => f.user_id)]);
    await c.query(
      `INSERT INTO club_former_members (club_code, user_id, left_at, season, season_points, lifetime_points, matches_played, matches_won, hands_won)
       SELECT $1, r.user_id, to_timestamp(r.left_at / 1000.0), r.season, r.season_points, r.points, r.matches_played, r.matches_won, r.hands_won
       FROM jsonb_to_recordset($2::jsonb) AS r(user_id uuid, left_at double precision, season integer, season_points integer, points integer,
            matches_played integer, matches_won integer, hands_won integer)
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)
       ON CONFLICT (club_code, user_id) DO UPDATE SET left_at = excluded.left_at, season = excluded.season, season_points = excluded.season_points,
         lifetime_points = excluded.lifetime_points, matches_played = excluded.matches_played, matches_won = excluded.matches_won, hands_won = excluded.hands_won`,
      [club.code, json(former)],
    );
  };
  /** Clubs with a row for this account (member, request, owner, ban, standings on file, a lapse on file as an owner, a finished season or a closed match). */
  const clubsNaming = async (c: Queryable, userId: string): Promise<string[]> => {
    const res = await c.query<{ code: string }>(
      `SELECT club_code AS code FROM club_members WHERE user_id = $1
       UNION SELECT code FROM clubs WHERE owner_id = $1
       UNION SELECT club_code FROM club_bans WHERE user_id = $1
       UNION SELECT club_code FROM club_former_members WHERE user_id = $1
       UNION SELECT code FROM clubs WHERE owner_lapses @> jsonb_build_array(jsonb_build_object('userId', $1::text))
       UNION SELECT code FROM clubs WHERE season_history @> jsonb_build_array(jsonb_build_object('standings', jsonb_build_array(jsonb_build_object('userId', $1::text))))
       UNION SELECT code FROM clubs WHERE closed_matches @> jsonb_build_array(jsonb_build_object('closedBy', jsonb_build_object('userId', $1::text)))
          OR closed_matches @> jsonb_build_array(jsonb_build_object('seats', jsonb_build_array(jsonb_build_object('userId', $1::text))))
       ORDER BY code`,
      [userId],
    );
    return res.rows.map((r) => r.code);
  };
  return {
    save: (club) => tx((c) => saveWith(c, club)),
    async delete(code) {
      const res = await q.query('DELETE FROM clubs WHERE code = $1', [code]);
      return (res.rowCount ?? 0) > 0;
    },
    async get(code) {
      return (await load(q, [code]))[0] ?? null;
    },
    loadAll: () => load(q, null),
    async isMember(clubCode, userId) {
      if (!isUuid(userId)) return false;
      const res = await q.query("SELECT 1 FROM club_members WHERE club_code = $1 AND user_id = $2 AND status = 'member'", [clubCode, userId]);
      return (res.rowCount ?? 0) > 0;
    },
    async clubsForUser(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<{ club_code: string; role: ClubMembership['role']; status: ClubMembership['status'] }>(
        'SELECT club_code, role, status FROM club_members WHERE user_id = $1 ORDER BY joined_at, club_code',
        [userId],
      );
      return res.rows.map((r) => ({ clubCode: r.club_code, role: r.role, status: r.status }));
    },
    // Merge and deletion use the same code as the memory repository and the club registry
    // (clubs.ts), applied to the clubs that name the account and written back in one transaction,
    // so the three can never disagree about who ends up owning a club.
    async moveMemberships(fromUserId, to) {
      if (!isUuid(fromUserId) || !isUuid(to.userId)) return [];
      return tx(async (c) => {
        const clubs = await load(c, await clubsNaming(c, fromUserId));
        const changed = moveMembershipsIn(clubs, fromUserId, to);
        for (const club of clubs) if (changed.includes(club.code)) await saveWith(c, club);
        return changed;
      });
    },
    async anonymiseUser(userId) {
      if (!isUuid(userId)) return [];
      return tx(async (c) => {
        const clubs = new Map((await load(c, await clubsNaming(c, userId))).map((club) => [club.code, club]));
        // How many clubs each possible successor already owns (only three may be handed to one account).
        const candidates = [...new Set([...clubs.values()].filter((club) => club.ownerId === userId).flatMap((club) => club.members.map((m) => m.userId)))].filter(isUuid);
        const owned = new Map<string, number>();
        if (candidates.length) {
          const res = await c.query<{ owner_id: string; n: number }>('SELECT owner_id, count(*)::int AS n FROM clubs WHERE owner_id = ANY($1::uuid[]) GROUP BY owner_id', [candidates]);
          for (const r of res.rows) owned.set(r.owner_id, r.n);
        }
        const changed = anonymiseUserIn(clubs, userId, (id) => owned.get(id) ?? 0);
        for (const code of changed) {
          const club = clubs.get(code);
          // Nobody else was in it: the club is dissolved (members and tables cascade).
          if (club) await saveWith(c, club);
          else await c.query('DELETE FROM clubs WHERE code = $1', [code]);
        }
        return changed;
      });
    },
  };
}

interface AllowanceRow {
  kind: 'address' | 'device';
  club_code: string;
  key: string;
  tokens: number;
  updated_at: Date;
}

const allowanceFromRow = (r: AllowanceRow): JoinAllowanceRecord => ({ kind: r.kind, clubCode: r.club_code, key: r.key, tokens: Number(r.tokens), updatedAt: r.updated_at.getTime() });

interface HourRow {
  kind: JoinHourRecord['kind'];
  key: string;
  tokens: number;
  updated_at: Date;
}

const hourFromRow = (r: HourRow): JoinHourRecord => ({ kind: r.kind, key: r.key, tokens: Number(r.tokens), updatedAt: r.updated_at.getTime() });

export function pgJoinAllowances(q: Queryable): JoinAllowancesRepo {
  const COLS = 'kind, club_code, key, tokens, updated_at';
  return {
    async salt() {
      const res = await q.query<{ salt: string }>('SELECT salt FROM counter_salt WHERE id = 1');
      if (!res.rows[0]) throw new Error('counter_salt has no row');
      return res.rows[0].salt;
    },
    async list(since) {
      const res = await q.query<AllowanceRow>('SELECT ' + COLS + ' FROM club_join_allowances WHERE updated_at >= $1', [toDate(since)]);
      return res.rows.map(allowanceFromRow);
    },
    async forClub(clubCode, since) {
      const res = await q.query<AllowanceRow>('SELECT ' + COLS + ' FROM club_join_allowances WHERE club_code = $1 AND updated_at >= $2 ORDER BY kind, tokens, key', [clubCode, toDate(since)]);
      return res.rows.map(allowanceFromRow);
    },
    async save(r) {
      await q.query(
        `INSERT INTO club_join_allowances (kind, club_code, key, tokens, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (kind, club_code, key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
        [r.kind, r.clubCode, r.key, Math.max(0, r.tokens), toDate(r.updatedAt)],
      );
    },
    async prune(before) {
      const res = await q.query('DELETE FROM club_join_allowances WHERE updated_at < $1', [toDate(before)]);
      return res.rowCount ?? 0;
    },
    async listHours(since) {
      const res = await q.query<HourRow>('SELECT kind, key, tokens, updated_at FROM club_join_hours WHERE updated_at >= $1', [toDate(since)]);
      return res.rows.map(hourFromRow);
    },
    async saveHour(r) {
      await q.query(
        `INSERT INTO club_join_hours (kind, key, tokens, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
        [r.kind, r.key, Math.max(0, r.tokens), toDate(r.updatedAt)],
      );
    },
    async pruneHours(before) {
      const res = await q.query('DELETE FROM club_join_hours WHERE updated_at < $1', [toDate(before)]);
      return res.rowCount ?? 0;
    },
  };
}

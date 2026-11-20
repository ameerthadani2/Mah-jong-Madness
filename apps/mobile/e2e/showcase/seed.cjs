/**
 * Sample data for the showcase (docs/SCREENSHOTS.md): sixteen fictional players, today's daily puzzle board, Puzzle
 * Rush runs and puzzle ratings, a club for each showcase account with members and season standings, and diamonds in
 * both wallets. Never run this against a real database: it writes straight into the tables.
 *   node seed.cjs <state-en.json> <state-zh.json> clubs   creates the two clubs over the API (the server fills in rules)
 *   node seed.cjs <state-en.json> <state-zh.json> data    fills everything in SQL (DATABASE_URL); restart the server
 *                                                         afterwards so it loads the club members
 */
const { randomUUID } = require('crypto');
const { Client } = require('pg');

const [stateEn, stateZh, step] = process.argv.slice(2);
const API = process.env.SIGNAL_HTTP || 'http://localhost:8787';

const auth = (file) => {
  const s = require(require('path').resolve(file));
  for (const o of s.origins) for (const it of o.localStorage) if (it.name.startsWith('mjm.auth')) return JSON.parse(it.value);
  throw new Error('no account in ' + file);
};

const PLAYERS = [
  ['Jason Lin', 'gent'],
  ['阿德', 'uncle'],
  ['Wei-Ting', 'student'],
  ['Grace H.', 'shades'],
  ['老張', 'boss'],
  ['Kevin Wu', 'hoops'],
  ['阿嬤 Ama', 'grandma'],
  ['Yu-Chen', 'sporty'],
  ['虎哥 Tiger', 'cowboy'],
  ['美華', 'auntie'],
  ['Daniel Tsai', 'chef'],
  ['小雨', 'student'],
  ['Hsin-Yi', 'shades'],
  ['Mahjong Mike', 'hoops'],
  ['阿翔', 'sporty'],
  ['Lily Chen', 'auntie'],
];
/** The fictional players are told apart from real guests by this birth year. */
const SAMPLE_YEAR = 1985;

/** packages/engine rating.ts rushScore. */
const rushScore = (solved, seconds) => solved * (100 + Math.round(50 * Math.min(1, Math.max(0, (30 - seconds / solved) / 25))));

async function clubs() {
  for (const [file, name] of [
    [stateEn, 'Tuesday Night Tiles'],
    [stateZh, '大稻埕麻將會'],
  ]) {
    const r = await fetch(API + '/api/clubs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth(file).session.token }, body: JSON.stringify({ name }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`club ${name}: ${r.status} ${JSON.stringify(body)}`);
    console.log('club', name, body.code);
  }
}

async function data() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const en = auth(stateEn).userId;
  const zh = auth(stateZh).userId;
  await db.query("DELETE FROM users WHERE kind = 'guest' AND birth_year = $1", [SAMPLE_YEAR]);
  for (const u of [en, zh]) for (const table of ['puzzle_results', 'puzzle_rush_runs', 'puzzle_ratings']) await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [u]);
  const ids = [];
  for (const [name, avatar] of PLAYERS) {
    const id = randomUUID();
    ids.push(id);
    await db.query("INSERT INTO users (id, kind, display_name, avatar, birth_year, created_at, last_seen_at) VALUES ($1, 'guest', $2, $3, $4, now() - interval '90 days', now())", [id, name, avatar, SAMPLE_YEAR]);
  }
  const today = new Date().toISOString().slice(0, 10);
  // Today's daily: most solved, a few wrong; the two showcase players third and fourth.
  const daily = [
    [ids[2], true, 9],
    [ids[0], true, 12],
    [en, true, 14],
    [zh, true, 17],
    [ids[5], true, 21],
    [ids[1], true, 24],
    [ids[9], true, 26],
    [ids[3], true, 31],
    [ids[7], true, 38],
    [ids[12], true, 44],
    [ids[6], true, 52],
    [ids[10], true, 67],
    [ids[4], false, 19],
    [ids[13], false, 33],
  ];
  for (const [u, correct, secs] of daily) {
    await db.query("INSERT INTO puzzle_results (user_id, kind, puzzle_key, correct, seconds, created_at, ranked) VALUES ($1, 'daily', $2, $3, $4::int, now() - make_interval(mins => $4::int), true)", [u, today, correct, secs]);
  }
  // Puzzle Rush: one best run each, finished today.
  const rush = [
    [ids[7], 31, 176],
    [en, 27, 172],
    [ids[0], 26, 178],
    [zh, 24, 170],
    [ids[2], 23, 175],
    [ids[11], 21, 179],
    [ids[5], 19, 168],
    [ids[8], 18, 180],
    [ids[3], 16, 177],
    [ids[14], 15, 171],
    [ids[1], 13, 180],
    [ids[15], 11, 166],
  ];
  for (const [u, solved, secs] of rush) {
    await db.query(
      "INSERT INTO puzzle_rush_runs (id, user_id, seed, started_at, expires_at, finished_at, solved, wrong, seconds, score, ranked, served_index, served_at) VALUES ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour', now() - interval '2 hours' + make_interval(secs => $6::int), $4::int, 3, $6::int, $5, true, $4::int, now() - interval '2 hours')",
      [randomUUID(), u, 'showcase-' + solved, solved, rushScore(solved, secs), secs],
    );
  }
  // Puzzle ratings (the board lists accounts with 20 or more rated answers).
  const ratings = [
    [ids[2], 1874, 412],
    [ids[0], 1811, 655],
    [ids[7], 1760, 301],
    [ids[12], 1702, 188],
    [en, 1648, 236],
    [zh, 1615, 203],
    [ids[5], 1583, 140],
    [ids[9], 1540, 97],
    [ids[1], 1497, 260],
    [ids[3], 1452, 75],
    [ids[6], 1406, 122],
    [ids[10], 1371, 64],
    [ids[13], 1322, 51],
    [ids[4], 1288, 88],
  ];
  for (const [u, rating, rated] of ratings) {
    await db.query('INSERT INTO puzzle_ratings (user_id, rating, rated, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (user_id) DO UPDATE SET rating = $2, rated = $3', [u, rating, rated]);
  }
  // Each club: eleven members with season standings, and the owner second this season.
  const owned = await db.query('SELECT code, owner_id FROM clubs WHERE owner_id = ANY($1::uuid[])', [[en, zh]]);
  for (const c of owned.rows) {
    const members = c.owner_id === en ? [0, 2, 3, 5, 7, 10, 12, 13, 15, 1, 9] : [1, 4, 6, 8, 9, 11, 14, 0, 2, 5, 7];
    const points = [1840, 1515, 1260, 990, 860, 610, 420, 300, -150, -380, -620];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const [name, avatar] = PLAYERS[m];
      const played = 14 + ((m * 7) % 11);
      await db.query(
        "INSERT INTO club_members (club_code, user_id, role, status, display_name, avatar, joined_at, season_points, lifetime_points, matches_played, matches_won, hands_won) VALUES ($1, $2, $3, 'member', $4, $5, now() - make_interval(days => $6::int + 10), $7::int, $7::int + 900, $8, $9, $10)",
        [c.code, ids[m], i < 2 ? 'admin' : 'member', name, avatar, m, points[i], played, Math.max(1, Math.round(played * (0.39 - i * 0.03))), Math.round(played * 3.1 - i)],
      );
    }
    await db.query('UPDATE club_members SET season_points = 1690, lifetime_points = 4210, matches_played = 22, matches_won = 8, hands_won = 61 WHERE club_code = $1 AND user_id = $2', [c.code, c.owner_id]);
    const about =
      c.owner_id === en ? 'Friendly Taiwanese 16-tile games every Tuesday. House rules: 底100 / 台20, Normal speed. All levels welcome!' : '每週二晚上的台灣十六張麻將。底100／台20，一般速度。新手老手都歡迎！';
    await db.query("UPDATE clubs SET description = $2, created_at = now() - interval '120 days' WHERE code = $1", [c.code, about]);
  }
  for (const u of [en, zh]) {
    await db.query('INSERT INTO wallets (user_id, diamonds, bonus_diamonds, updated_at) VALUES ($1, 1240, 60, now()) ON CONFLICT (user_id) DO UPDATE SET diamonds = 1240, bonus_diamonds = 60', [u]);
  }
  console.log('seeded', ids.length, 'players and clubs', owned.rows.map((r) => r.code).join(', '));
  await db.end();
}

(step === 'clubs' ? clubs() : data()).catch((e) => {
  console.error(e);
  process.exit(1);
});

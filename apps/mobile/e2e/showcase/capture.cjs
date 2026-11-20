/**
 * Showcase capture (docs/SCREENSHOTS.md): staged screenshots of the app for people to look at. Not a test.
 * Needs a web export built with `--dev` and EXPO_PUBLIC_STORE_MODE=mock (so the Shop shows prices), the game server on
 * localhost:8787 seeded by seed.cjs, and the storage state boot.cjs saved for the account.
 * Usage: node capture.cjs <webdir> <outdir> <state.json> <en|zh> <phone|tablet> [deal seed] [only=table,learn,clubs,shop]
 */
const fs = require('fs');
const path = require('path');
const { PORT, serve, launch, SEEDED_DEAL, visible, tap, tapSel, playHand, t } = require('./lib.cjs');

const [webdir, outArg, stateFile, lang, device, seedArg, onlyArg] = process.argv.slice(2);
const out = path.resolve(outArg);
const DEAL = Number(seedArg || 3);
const ONLY = (onlyArg || '').replace(/^only=/, '').split(',').filter(Boolean);
const want = (story) => !ONLY.length || ONLY.includes(story);
fs.mkdirSync(out, { recursive: true });

// A phone the size of the App Store's 6.7" screenshots (1290x2796) and an 11" tablet in landscape (2388x1668).
const DEVICES = {
  phone: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 },
  tablet: { viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2 },
};
const T = (ns, key) => t(lang, ns, key);

/** A lived-in device: lessons done, a daily streak, puzzle stats and hands played; the first-game tap hint retired. */
const LIVED_IN = () => {
  if (sessionStorage.getItem('showcase.seeded')) return;
  sessionStorage.setItem('showcase.seeded', '1');
  const day = (n) => {
    const d = new Date(Date.now() - n * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dailySolved = {};
  for (let n = 1; n <= 12; n++) dailySolved[day(n)] = 'correct';
  const lessons = ['tiles', 'win', 'calls', 'scoring', 'efficiency', 'defence', 'basics-flowers', 'basics-match', 'basics-seat', 'eff-acceptance', 'eff-shapes', 'eff-pairs', 'eff-early', 'call-chi', 'call-pong'];
  const progress = {
    lessonsDone: Object.fromEntries(lessons.map((l) => [l, true])),
    drillsPlayed: 86,
    drillsCorrect: 64,
    handsPlayed: 128,
    handsWon: 37,
    dailySolved,
    dailyStreak: 12,
    dailyLastDate: day(1),
    rushBest: 27,
    rushRuns: 19,
    rushBestScore: 3618,
    puzzleRating: 1648,
    ratingHistory: [],
    reviewAccuracies: [82, 86, 79, 90, 88],
    lastCountedHand: null,
    reviewedHands: [],
  };
  localStorage.setItem('mjm.progress', JSON.stringify(progress));
  localStorage.setItem('mjm.tapHint', '3');
  localStorage.removeItem('mjm.activeSession');
};

let shots = 0;
async function shot(page, name) {
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(out, `${device}-${lang}-${name}.png`) });
  shots++;
  console.log('  shot', `${device}-${lang}-${name}.png`);
}

async function open(browser, { seeded = false } = {}) {
  const ctx = await browser.newContext({ ...DEVICES[device], locale: lang === 'zh' ? 'zh-TW' : 'en-US', storageState: stateFile, colorScheme: 'light' });
  await ctx.addInitScript(LIVED_IN);
  if (seeded) await ctx.addInitScript(SEEDED_DEAL);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  pageerror', e.message.slice(0, 160)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 60000 });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

/** The visible element whose text is exactly `text` (stroked labels repeat it; any copy will do). */
const tapText = (page, text, wait) => tapSel(page, `text="${text}"`, wait);

/** The test store's notice is for development builds only: hide it so the Shop looks as it does in a release build. */
const hideTestStoreNotice = (page) =>
  page.evaluate((text) => {
    for (const el of document.querySelectorAll('div')) {
      if (el.childElementCount !== 0 || el.textContent !== text) continue;
      // Up to the pill: the last ancestor still short enough to be one line of notice.
      let pill = el;
      while (pill.parentElement && pill.parentElement.getBoundingClientRect().height < 90) pill = pill.parentElement;
      pill.style.display = 'none';
    }
  }, T('shop', 'mock'));

/** The seeded hand: Home, a claim the coach advises on, a turn with the coach's tile ringed, the win, the result. */
async function storyTable(browser) {
  const { ctx, page } = await open(browser, { seeded: true });
  await shot(page, 'home');
  await page.evaluate((s) => window.__arm(s), DEAL);
  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 30000 });
  const done = new Set();
  const once = async (name, wait) => {
    if (done.has(name)) return;
    done.add(name);
    await page.waitForTimeout(wait);
    await shot(page, name);
  };
  const r = await playHand(page, {
    on: async (event, discards) => {
      if (event === 'tick' && !done.has('win-reveal') && (await visible(page, '[data-testid="win-reveal"]'))) await once('win-reveal', 600);
      if (event === 'win') await once('win-prompt', 700);
      if (event === 'claim' && discards >= 4) await once('table-claim', 900);
      if (event === 'turn' && discards >= 7) await once('table-turn', 800);
    },
  });
  if (!r.done) console.log('  the hand did not finish');
  await page.waitForTimeout(3500);
  await shot(page, 'result');
  const text = await page.$eval('[data-testid="result-sheet"]', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
  console.log('  result:', text.slice(0, 200));
  if (await tapSel(page, '[data-testid="audit-status"]', 1500)) {
    await shot(page, 'fair-hand');
    await tapSel(page, '[data-testid="back"]', 1500);
  }
  if (await tapText(page, T('table', 'result.reviewMyHand'), 2500)) await shot(page, 'review');
  await ctx.close();
}

async function storyLearn(browser) {
  const { ctx, page } = await open(browser);
  await tapSel(page, '[data-testid="open-learn"]', 2000);
  await shot(page, 'learn');
  if (await tapText(page, T('learn', 'daily.cta'), 3000)) {
    await shot(page, 'daily');
    await tapSel(page, '[data-testid="back"]', 1500);
  }
  if (await tapSel(page, '[data-testid="open-leaderboards"]', 2500)) {
    await shot(page, 'boards-daily');
    if (await tapSel(page, '[data-testid="board-tab-rush"]', 2000)) await shot(page, 'boards-rush');
    if (await tapSel(page, '[data-testid="board-tab-rating"]', 2000)) await shot(page, 'boards-rating');
  }
  await ctx.close();
}

async function storyClubs(browser) {
  const { ctx, page } = await open(browser);
  await tapSel(page, '[data-testid="open-clubs"]', 2500);
  await shot(page, 'clubs');
  if (await tapText(page, T('clubs', 'open'), 2500)) {
    if (await tapText(page, T('clubs', 'tabs.standings'), 2000)) await shot(page, 'club-standings');
    if (await tapText(page, T('clubs', 'tabs.members').replace('%{n}', '12'), 2000)) await shot(page, 'club-members');
    if (await tapText(page, T('clubs', 'tabs.rules'), 2000)) await shot(page, 'club-rules');
  }
  await ctx.close();
}

async function storyShop(browser) {
  const { ctx, page } = await open(browser);
  await tapSel(page, '[data-testid="open-shop"]', 2500);
  const settle = async () => {
    await hideTestStoreNotice(page);
    await page.waitForTimeout(400);
  };
  await settle();
  await shot(page, 'shop');
  if (await tapSel(page, '[data-testid="shop-tab-coach"]', 1500)) {
    await settle();
    await shot(page, 'shop-plans');
  }
  if (await tapSel(page, '[data-testid="shop-tab-looks"]', 1500)) {
    await settle();
    await shot(page, 'shop-looks');
    for (const p of await page.$$('[data-testid^="preview-"]')) {
      if (/night|imperial|jade/.test((await p.getAttribute('data-testid')) || '') && (await p.isVisible())) {
        await tap(page, p);
        await page.waitForTimeout(1500);
        await shot(page, 'shop-preview');
        break;
      }
    }
  }
  await ctx.close();
}

(async () => {
  const server = await serve(webdir);
  const browser = await launch();
  try {
    if (want('table')) await storyTable(browser);
    if (want('learn')) await storyLearn(browser);
    if (want('clubs')) await storyClubs(browser);
    if (want('shop')) await storyShop(browser);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('shots', shots);
})();

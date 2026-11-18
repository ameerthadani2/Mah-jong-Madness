/**
 * Layout screenshots: serves a web export and captures the main screens at the five reference viewports
 * (phone portrait, phone landscape, small phone landscape, small Android portrait, tablet landscape).
 *
 *   CI=1 npx expo export --platform web --output-dir dist-e2e   (from apps/mobile)
 *   node e2e/screens.cjs dist-e2e [screenshot-dir]
 *   npm run e2e:screens                                           (both steps)
 *
 * Writes <dir>/<width>x<height>-<screen>.png for home, table-mid, table-selected, table-claim (when a claim
 * came up), callout and win-hold (when they came up), result, review, replace-table (Home asking before a new
 * match replaces a saved table), abandon-table (Home asking before the Resume card gives a saved table up), learn, lesson, age-gate (the birth-year
 * question a new player answers before the Shop), shop and settings, plus exit-sheet (the red exit icon's
 * confirmation) and, for each landscape viewport, table-xl (Extra-large tiles).
 * Each viewport plays one hand against bots in its own browser context, all in parallel. Set
 * SCREENS_SIZES=390x844,667x375 to capture a subset of the viewports, and SCREENS_ONLY=preview,xl (say) to run a
 * subset of the groups (named where the runs start, at the end of this file).
 * Exits non-zero if a viewport cannot reach the result sheet, the page throws, or a hard check fails (one tap on
 * the exit icon or on the result sheet's "Leave table" leaves the table, Start match replaces a saved table
 * without asking, one tap on the Resume card's "Abandon table" gives the saved table up, the English claim buttons carry no gloss, an Extra-large hand scrolls or runs off screen, the
 * Shop does not open, a Home card button clips its label in English or in Traditional Chinese (each viewport also
 * opens Home in zh-TW and writes <size>-home-zh.png), Home's cards run past the bottom edge at 844x390), or the
 * leaderboard screen (opened from Learn without a server, in English, zh-TW and Extra-large text: <size>-leaderboards.png,
 * -leaderboards-zh.png, -leaderboards-xl.png) does not show its offline state, clips text or has a choice under 44 px,
 * a table HUD icon takes a press smaller than 44 x 44 px, the Shop's Looks tab cuts a description (<size>-shop-looks.png),
 * or a seat name is cut at a table in Traditional Chinese (each viewport at Normal text, and the portrait ones again at
 * Extra-large text: <size>-table-zh.png, <size>-table-zh-xl.png at every viewport; the hand tiles' size is logged as a note),
 * or the Shop's try-on preview fails its checks (runPreview below: <size>-preview-<kind>.png and -zh.png, at every
 * viewport and at 320x568). The preview, the exit sheet and Home's replace-table question also fail on the keyboard
 * (dialogKeys): Tab ten times and Shift+Tab four times must stay on the dialog's own controls, never its scrim or the
 * page behind, and the page behind must be inert while the dialog is open and not after.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || 'dist-e2e');
const out = path.resolve(process.argv[3] || 'e2e-shots');
fs.mkdirSync(out, { recursive: true });

const ALL_SIZES = [
  [390, 844],
  [844, 390],
  [667, 375],
  [360, 740],
  [1024, 768],
];
const wanted = (process.env.SCREENS_SIZES || '').split(',').filter(Boolean);
const SIZES = wanted.length ? ALL_SIZES.filter(([w, h]) => wanted.includes(`${w}x${h}`)) : ALL_SIZES;

const types = { '.html': 'text/html', '.js': 'application/javascript', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// Tap by screen position like a finger: stroked labels are stacked text copies that Playwright's element click refuses.
const tap = async (page, el) => {
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  const bb = await el.boundingBox();
  if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  return !!bb;
};
const visible = async (page, sel) => {
  for (const el of await page.$$(sel)) if (await el.isVisible().catch(() => false)) return el;
  return null;
};
const tapSel = async (page, sel, wait = 900) => {
  const el = await visible(page, sel);
  if (!el) return false;
  await tap(page, el);
  await page.waitForTimeout(wait);
  return true;
};

/** Whether the app's root element (everything but a dialog's portal) is inert. */
const pageInert = (page) => page.evaluate(() => !!document.getElementById('root')?.hasAttribute('inert'));

/**
 * An open dialog's keyboard checks: the page behind it is inert, and Tab (`tabs` times) then Shift+Tab (4 times) move
 * focus only through the dialog's own controls, never to the scrim, to something hidden from screen readers or to the
 * page behind. Reads document.activeElement after every key.
 */
async function dialogKeys(page, tabs = 10) {
  const bad = [];
  if (!(await pageInert(page))) bad.push('the page behind the dialog is not inert');
  const focus = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().width > 0);
      const name = a && a !== document.body ? a.getAttribute('data-testid') || a.getAttribute('aria-label') || a.tagName : 'nothing';
      // A control, or a part of the dialog that scrolls (the browser makes a scroller a Tab stop so the keyboard can scroll it).
      const st = a ? getComputedStyle(a) : null;
      const scroller = !!a && /auto|scroll/.test(`${st.overflowY} ${st.overflowX}`) && (a.scrollHeight > a.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1);
      const control = !!a && (scroller || a.matches('[role="button"], button, a[href], input, textarea, [role="link"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"]'));
      // The scrim covers the whole window: no focus stop, even as a labelled button.
      const r = a ? a.getBoundingClientRect() : null;
      const scrim = !!r && r.width >= innerWidth - 2 && r.height >= innerHeight - 2;
      return { name, inDialog: !!(dlg && a && dlg.contains(a)), hidden: !!a?.closest('[aria-hidden="true"]'), control, scrim };
    });
  for (const [key, n] of [['Tab', tabs], ['Shift+Tab', 4]]) {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(key);
      const f = await focus();
      if (!f.inDialog || f.hidden || !f.control || f.scrim) {
        bad.push(`${key} ${i + 1} put focus on ${f.name} (${!f.inDialog ? 'outside the dialog' : f.hidden ? 'hidden from screen readers' : f.scrim ? 'the scrim' : 'not a control'})`);
        break;
      }
    }
  }
  return bad;
}

/**
 * Home's hard checks, run on the page as it stands. Card buttons are as wide as their card, so a label (with its
 * icon) wider than the button is cut off at both ends. And where the cards sit side by side on a phone held
 * sideways (844x390), everything must end above the bottom edge: the page must not need to scroll.
 */
async function homeFit(page) {
  return page.evaluate(() => {
    const bad = [];
    for (const id of ['start-match', 'open-clubs', 'open-quickmatch', 'open-learn', 'open-shop-card']) {
      const el = [...document.querySelectorAll(`[data-testid="${id}"]`)].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) continue;
      const parts = [...el.querySelectorAll('div[dir="auto"], svg')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
      if (!parts.length) continue;
      const content = Math.max(...parts.map((r) => r.right)) - Math.min(...parts.map((r) => r.left));
      // The button's 3 px border on each side is not room for the label.
      if (content > el.getBoundingClientRect().width - 6) bad.push(`button ${id} clips its label (${Math.round(content)} in ${Math.round(el.getBoundingClientRect().width)})`);
    }
    if (innerWidth >= 800 && innerHeight < 420) {
      let scroller = null;
      for (const e of document.querySelectorAll('div')) {
        const st = getComputedStyle(e);
        if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && (!scroller || e.clientHeight * e.clientWidth > scroller.clientHeight * scroller.clientWidth)) scroller = e;
      }
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) bad.push(`the cards run past the bottom edge (${scroller.scrollHeight} in ${scroller.clientHeight})`);
    }
    return bad;
  });
}

/** Home in Traditional Chinese at one viewport: the same hard checks, on the longer of the two languages' labels. */
/**
 * The table's hard checks, on the page as it stands: every seat name shown whole (a long one may take two lines,
 * never be cut), a landscape side seat's tag on two lines at most (name; relation and score), the coach's advice line in view
 * whenever the coach's bubble shows, and each HUD icon (emotes, coach, exit) a press of at least 44 x 44 px. The web ignores hitSlop,
 * so the box itself must be that big. Also returns the smallest hand tile, for the notes.
 */
async function tableFit(page) {
  return page.evaluate(() => {
    const bad = [];
    const seen = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const plates = [...document.querySelectorAll('[data-testid="seat-name"]')].filter(seen);
    if (plates.length < 4) bad.push(`${plates.length} seat names showing, not 4`);
    for (const el of plates) if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2) bad.push(`seat name "${el.textContent}" is cut (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`);
    // The seat's relation label ("Right 下家") stays on one line, never broken inside 下家, and is never cut.
    for (const el of [...document.querySelectorAll('[data-testid="seat-rel"]')].filter(seen)) {
      const r = el.getBoundingClientRect();
      if (r.height > parseFloat(getComputedStyle(el).fontSize) * 1.7) bad.push(`seat label "${el.textContent}" takes two lines (${Math.round(r.height)} px high)`);
      if (el.scrollWidth > el.clientWidth + 1) bad.push(`seat label "${el.textContent}" is cut (${el.scrollWidth} in ${el.clientWidth})`);
    }
    // A landscape side seat's tag keeps to two lines: its name on one, its relation label and score on the other.
    const oneLine = (el) => el.getBoundingClientRect().height <= Math.max(...[el, ...el.querySelectorAll('*')].map((x) => parseFloat(getComputedStyle(x).fontSize) || 0)) * 1.7;
    for (const tag of [...document.querySelectorAll('[data-testid="seat-tag-side"]')].filter(seen)) {
      const name = tag.querySelector('[data-testid="seat-name"]');
      const row = tag.querySelector('[data-testid="seat-row"]');
      if (name && !oneLine(name)) bad.push(`side seat name "${name.textContent}" takes more than one line (${Math.round(name.getBoundingClientRect().height)} px high), so its tag takes three`);
      if (row && !oneLine(row)) bad.push(`side seat "${name?.textContent}": its relation and score take more than one line (${Math.round(row.getBoundingClientRect().height)} px high)`);
    }
    const leave = document.querySelector('[data-testid="leave-table"]');
    const icons = leave ? [...leave.parentElement.querySelectorAll('[role="button"]')] : [];
    if (icons.length < 2) bad.push('the HUD icons are not showing');
    for (const el of icons) {
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) bad.push(`HUD icon "${el.getAttribute('aria-label')}" takes a ${Math.round(r.width)}x${Math.round(r.height)} px press`);
    }
    const hand = [...document.querySelectorAll('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]')].map((e) => e.getBoundingClientRect());
    const tile = hand.length ? `${Math.round(Math.min(...hand.map((b) => b.width)))}x${Math.round(Math.min(...hand.map((b) => b.height)))}` : 'none';
    // The coach's advice (the tile to discard, or the claim to make) is on screen whenever the bubble is: its first
    // line inside the coach's scroll box, at every viewport and text size (a status line that wraps never pushes it out).
    for (const box of [...document.querySelectorAll('[data-testid="coach-text"]')].filter(seen)) {
      const adv = box.querySelector('[data-testid="coach-advice"]') || [...box.querySelectorAll('[dir="auto"]')].at(-1);
      if (!adv || !adv.textContent.trim()) continue;
      const a = adv.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const cs = getComputedStyle(adv);
      const line = Math.min(a.height, parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3);
      const bottom = Math.min(b.bottom, innerHeight);
      if (a.top < b.top - 1 || a.top + line > bottom + 1) bad.push(`the coach's advice "${adv.textContent.slice(0, 30)}" is out of view: its first line at ${Math.round(a.top)}-${Math.round(a.top + line)} px, the coach's box ${Math.round(b.top)}-${Math.round(bottom)} px`);
    }
    return { bad, tile };
  });
}

/**
 * The coach's advice out of view (tableFit's check), once the bubble has settled: a new status line is measured
 * one frame after it shows, so a finding is kept only if it is still there 600 ms later.
 */
async function coachOut(page) {
  const out = (await tableFit(page)).bad.filter((x) => /coach's advice/.test(x));
  if (!out.length) return [];
  await page.waitForTimeout(600);
  return (await tableFit(page)).bad.filter((x) => /coach's advice/.test(x));
}

/** A table in Traditional Chinese (bot names such as 小美（電腦）), at Normal or Extra-large text: <size>-table-zh[-xl].png. */
async function runTableZh(browser, port, [w, h], xl) {
  const tag = `${w}x${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'zh-TW' });
  await ctx.addInitScript((big) => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
    if (big) localStorage.setItem('mjm.display', JSON.stringify({ tileScale: 1, textScale: 1.3 }));
  }, xl);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  await page.waitForTimeout(1500);
  const name = xl ? 'table-zh-xl' : 'table-zh';
  await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
  const where = `Table (zh-TW${xl ? ', Extra-large text' : ''})`;
  const fails = [];
  if (!(await page.evaluate(() => [...document.querySelectorAll('[data-testid="seat-name"]')].some((e) => /電腦/.test(e.textContent))))) fails.push(`${where}: no bot seat is named in Chinese`);
  const fit = await tableFit(page);
  fails.push(...fit.bad.map((f) => `${where}: ${f}`));
  // Play on for several of my discards (my pond grows a row, the coach's room shrinks): at each, before and after
  // the tile is picked, the coach's advice must stay in view (tableFit).
  const coach = new Set();
  for (let i = 0, mine = 0; i < 120 && mine < 8; i++) {
    let el;
    if ((el = await visible(page, '[data-testid="claim-pass"]'))) { await tap(page, el); await page.waitForTimeout(300); continue; }
    if (await visible(page, 'text=/胡/')) break;
    const boxes = await page.$$eval('[data-testid^="tile-"]:not([data-testid="tile-back"])', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    if (!boxes.length) break;
    const maxW = Math.max(...boxes.map((b) => b.w));
    const hand = boxes.filter((b) => b.w >= maxW * 0.9).sort((a, b) => b.y - a.y || b.x - a.x);
    if (await visible(page, '[data-testid="coach"]')) for (const f of await coachOut(page)) coach.add(f);
    if (hand[0]) await page.mouse.click(hand[0].x + hand[0].w / 2, hand[0].y + hand[0].h / 2);
    await page.waitForTimeout(250);
    if ((el = await visible(page, 'text="打"'))) {
      for (const f of await coachOut(page)) coach.add(f);
      await tap(page, el);
      mine++;
      if (mine === 6) await page.screenshot({ path: path.join(out, `${tag}-${name}-later.png`) });
    }
    await page.waitForTimeout(300);
  }
  fails.push(...[...coach].map((f) => `${where}, later in the hand: ${f}`));
  await ctx.close();
  return { size: `${tag} ${name}`, finished: true, shots: [name, `${name}-later`], notes: [`smallest hand tile ${fit.tile} px (the hand cannot give every tile 44 px of width)`], fails, errors };
}

async function runHomeZh(browser, port, [w, h]) {
  const tag = `${w}x${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'zh-TW' });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, `${tag}-home-zh.png`) });
  const fails = [];
  // The page must really be in Chinese, or the check would pass on English labels.
  if (!(await page.evaluate(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-testid="open-clubs"]')?.textContent || '')))) fails.push('Home (zh-TW): the page is not in Chinese');
  fails.push(...(await homeFit(page)).map((f) => `Home (zh-TW): ${f}`));
  // The wordmark reads the Chinese app name (common.appName), whole and on screen.
  const mark = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div[dir="auto"]')].filter((e) => e.children.length === 0 && e.textContent === '麻將狂熱' && e.getBoundingClientRect().width > 0);
    return els.map((e) => { const r = e.getBoundingClientRect(); return { off: r.left < -1 || r.right > innerWidth + 1 || r.top < -1, cut: e.scrollWidth > e.clientWidth + 1 || r.height > parseFloat(getComputedStyle(e).lineHeight || '0') * 1.6 + 2 }; });
  });
  if (mark.length === 0) fails.push('Home (zh-TW): the wordmark does not read 麻將狂熱');
  else if (mark.some((m) => m.off || m.cut)) fails.push('Home (zh-TW): the 麻將狂熱 wordmark is cut, wrapped or off screen');
  await ctx.close();
  return { size: `${tag} zh-TW`, finished: true, shots: ['home-zh'], notes: [], fails, errors };
}

async function run(browser, port, [w, h]) {
  const tag = `${w}x${h}`;
  const notes = [];
  // Hard checks: any entry fails the run.
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });

  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot('home');
  fails.push(...(await homeFit(page)).map((f) => `Home (en): ${f}`));

  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  let discards = 0;
  const done = new Set();
  const started = Date.now();
  while (Date.now() - started < 240000) {
    if (await visible(page, 'text=Next hand')) break;
    // The feel: a call-out banner, and the winner's hand face up during the hold before the result sheet.
    if (!done.has('win-hold') && (await visible(page, '[data-testid="win-reveal"]'))) { done.add('win-hold'); await page.waitForTimeout(700); await shot('win-hold'); }
    if (!done.has('callout') && (await visible(page, '[data-testid="call-banner"]'))) { done.add('callout'); await shot('callout'); }
    let el;
    if ((el = await visible(page, 'text=/胡!/'))) { await tap(page, el); await page.waitForTimeout(400); continue; }
    if ((el = await visible(page, 'text="過"'))) {
      if (!done.has('claim')) {
        done.add('claim');
        await shot('table-claim');
        // English players see a gloss on the Chinese claim verbs ("Pass 過").
        if (!(await visible(page, '[data-testid="claim-pass"] >> text=Pass'))) fails.push('claim buttons carry no English gloss');
      }
      await tap(page, el);
      await page.waitForTimeout(300);
      continue;
    }
    if ((el = await visible(page, 'text="打"'))) {
      if (discards >= 3 && !done.has('selected')) { done.add('selected'); await shot('table-selected'); }
      await tap(page, el);
      discards++;
      if (discards === 6) {
        await page.waitForTimeout(900);
        await shot('table-mid');
        done.add('mid');
        fails.push(...(await tableFit(page)).bad.map((f) => `Table (en): ${f}`));
      }
      if (discards === 4 && !done.has('exit-sheet')) {
        // The red exit icon asks first: one tap must not leave the table.
        done.add('exit-sheet');
        await tapSel(page, '[data-testid="leave-table"]', 700);
        if (!(await visible(page, '[data-testid="leave-sheet"]'))) fails.push('exit icon left without asking');
        await shot('exit-sheet');
        fails.push(...(await dialogKeys(page)).map((f) => `Exit sheet: ${f}`));
        await tapSel(page, '[data-testid="leave-stay"]', 500);
        if (!(await visible(page, '[data-testid="leave-table"]'))) fails.push('keep playing did not return to the table');
        if (await pageInert(page)) fails.push('Exit sheet: the table stays inert after the sheet closed');
      }
      await page.waitForTimeout(300);
      continue;
    }
    // My discard turn: the first-game tap hint, or (once it has retired) the hand marked for discarding.
    if ((await visible(page, 'text=Tap a tile, tap again to discard')) || (await visible(page, '[data-testid="hand-discard"]'))) {
      const boxes = await page.$$eval('[data-testid^="tile-"]:not([data-testid="tile-back"])', (els) =>
        els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      const maxW = Math.max(...boxes.map((b) => b.w));
      // The hand is the row of largest tiles; take the lowest, right-most one (the drawn tile in landscape).
      const hand = boxes.filter((b) => b.w >= maxW * 0.9).sort((a, b) => b.y - a.y || b.x - a.x);
      if (hand[0]) await page.mouse.click(hand[0].x + hand[0].w / 2, hand[0].y + hand[0].h / 2);
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(300);
  }
  if (!done.has('mid')) await shot('table-mid');
  const finished = !!(await visible(page, 'text=Next hand'));
  await page.waitForTimeout(600);
  await shot('result');
  if (!finished) notes.push('hand did not finish');

  if (finished) {
    if ((await tapSel(page, 'text=Review my hand', 1500)) || (await tapSel(page, 'text="Review"', 1500))) {
      await shot('review');
      await tapSel(page, '[data-testid="back"]', 900);
    } else notes.push('no review button');
    // The result sheet's "Leave table" asks like the exit icon does: one tap must not give the match up.
    if (await tapSel(page, 'text=Leave table', 900)) {
      if (!(await visible(page, '[data-testid="leave-sheet"]'))) fails.push('"Leave table" on the result sheet left without asking');
    } else await tapSel(page, '[data-testid="leave-table"]', 700);
    // Step away: Home keeps the table behind its Resume card.
    await tapSel(page, '[data-testid="leave-away"]', 1200);
  }
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 15000 }).catch(() => notes.push('did not return home'));
  if (finished) {
    if (!(await visible(page, '[data-testid="resume-card"]'))) fails.push('no Resume card on Home after stepping away from the table');
    // A new match would take the saved table's place: Home asks first, and "Keep my table" changes nothing.
    await tapSel(page, '[data-testid="start-match"]', 900);
    if (!(await visible(page, '[data-testid="replace-table"]'))) fails.push('Start match replaced the saved table without asking');
    else {
      await shot('replace-table');
      fails.push(...(await dialogKeys(page)).map((f) => `Replace-table question: ${f}`));
    }
    await tapSel(page, '[data-testid="confirm-no"]', 700);
    if (!(await visible(page, '[data-testid="resume-card"]'))) fails.push('"Keep my table" did not keep the saved table');
    if (await pageInert(page)) fails.push('Replace-table question: Home stays inert after the question closed');
    // "Abandon table" on the Resume card ends the saved table for good: one tap must only ask, and "Keep my table" keeps it.
    const savedTable = () => page.evaluate(() => (localStorage.getItem('mjm.activeSession') || '').length);
    if (!(await tapSel(page, '[data-testid="abandon-table"]', 900))) fails.push('the Resume card has no "Abandon table" button');
    if (!(await visible(page, '[data-testid="resume-card"]')) || !(await savedTable())) fails.push('one tap on "Abandon table" gave up the saved table without asking');
    if (!(await visible(page, '[data-testid="abandon-saved-table"]'))) fails.push('"Abandon table" on Home did not ask before giving up the saved table');
    else await shot('abandon-table');
    await tapSel(page, '[data-testid="confirm-no"]', 700);
    if (await visible(page, '[data-testid="abandon-saved-table"]')) fails.push('"Keep my table" did not close the abandon question');
    if (!(await visible(page, '[data-testid="resume-card"]')) || !(await savedTable())) fails.push('cancelling "Abandon table" did not keep the saved table');
    // Back to the table through Resume, then give it up for the rest of the walk.
    await tapSel(page, '[data-testid="resume-table"]', 1500);
    if (!(await visible(page, 'text=Next hand'))) fails.push('Resume did not bring the result sheet back');
    await tapSel(page, 'text=Leave table', 900);
    await tapSel(page, '[data-testid="leave-confirm"]', 1200);
    await page.waitForSelector('[data-testid="start-match"]', { timeout: 15000 }).catch(() => notes.push('did not return home after abandoning'));
    if (await visible(page, '[data-testid="resume-card"]')) fails.push('an abandoned table still shows a Resume card');
  }

  if (await tapSel(page, '[data-testid="open-learn"]', 1000)) {
    await shot('learn');
    if (await tapSel(page, 'text="Start"', 1000)) {
      await shot('lesson');
      await tapSel(page, '[data-testid="back"]', 800);
    } else notes.push('no lesson start button');
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no learn button');

  if (await tapSel(page, '[data-testid="open-shop"]', 1000)) {
    // A new player is asked their birth year before the Shop opens: capture the question, answer it as an adult.
    if (await visible(page, '[data-testid="age-gate"]')) {
      await shot('age-gate');
      await page.fill('[data-testid="age-year"]', '1990');
      await tapSel(page, '[data-testid="age-continue"]', 1000);
    }
    if (await visible(page, '[data-testid="shop"]')) {
      await shot('shop');
      // The Looks tab: every description shown whole, none cut mid-sentence.
      if (await tapSel(page, '[data-testid="shop-tab-looks"]', 800)) {
        await shot('shop-looks');
        const cut = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="product-"] div[dir="auto"]')]
          .filter((e) => e.getBoundingClientRect().width > 0 && e.textContent.trim() && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2))
          .map((e) => e.textContent.slice(0, 40)));
        for (const c of cut) fails.push(`Shop Looks: "${c}…" is cut`);
      } else fails.push('the Shop has no Looks tab');
    } else fails.push('the Shop did not open from Home (the "shop" screenshot would show another screen)');
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no shop button');

  if ((await tapSel(page, '[data-testid="open-settings"]', 1000)) || (await tapSel(page, 'text=Tester', 1000))) {
    await shot('settings');
    // A switch must say whether it is on: react-native-web drops accessibilityState, so the aria attribute carries it.
    const switches = await page.evaluate(() => [...document.querySelectorAll('[role="switch"]')].map((e) => e.getAttribute('aria-checked')));
    if (switches.length === 0) notes.push('no switch found in Settings');
    if (switches.some((v) => v !== 'true' && v !== 'false')) fails.push(`Settings: ${switches.filter((v) => v !== 'true' && v !== 'false').length} of ${switches.length} switches do not say whether they are on (aria-checked)`);
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no settings button');

  await ctx.close();
  return { size: tag, finished, discards, shots: [...done], notes, fails, errors };
}

/**
 * The leaderboard screen's hard checks, on the page as it stands: no text clipped (cut off inside its box) or off
 * the screen's sides, and every board, period and scope choice at least 44 px tall.
 */
async function boardsFit(page) {
  return page.evaluate(() => {
    const bad = [];
    const root = [...document.querySelectorAll('[data-testid="leaderboards"]')].find((e) => e.getBoundingClientRect().width > 0);
    if (!root) return ['the leaderboard screen is not showing'];
    for (const el of root.querySelectorAll('div[dir="auto"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || !el.textContent.trim()) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2) bad.push(`"${el.textContent.slice(0, 30)}" is clipped (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`);
      if (r.right > innerWidth + 1 || r.left < -1) bad.push(`"${el.textContent.slice(0, 30)}" runs off the screen`);
    }
    for (const el of root.querySelectorAll('[data-testid^="board-tab-"], [data-testid^="board-period-"], [data-testid^="board-scope-"]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height < 44) bad.push(`${el.dataset.testid} is ${Math.round(r.height)} px tall`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('the page scrolls sideways');
    return bad;
  });
}

/**
 * The leaderboard screen from Learn, without a game server: it must say it cannot reach the server. In English
 * (<size>-leaderboards.png), Traditional Chinese (<size>-leaderboards-zh.png) and English at Extra-large text
 * (<size>-leaderboards-xl.png), each with the fit checks above, on the daily board and on the Rush board.
 */
async function runBoards(browser, port, [w, h]) {
  const tag = `${w}x${h}`;
  const fails = [];
  const errors = [];
  const shots = [];
  for (const variant of ['en', 'zh', 'xl']) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: variant === 'zh' ? 'zh-TW' : 'en-US' });
    await ctx.addInitScript((xl) => {
      localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
      if (xl) localStorage.setItem('mjm.display', JSON.stringify({ tileScale: 1, textScale: 1.3 }));
    }, variant === 'xl');
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${variant}: ${e.message}`));
    const where = `Leaderboards (${variant})`;
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('[data-testid="open-learn"]', { timeout: 30000 });
    await tapSel(page, '[data-testid="open-learn"]', 1000);
    if (!(await tapSel(page, '[data-testid="open-leaderboards"]', 1000))) {
      fails.push(`${where}: Learn has no Leaderboards button`);
      await ctx.close();
      continue;
    }
    // A new player is asked their birth year before anything reaches the server: answer it as an adult.
    if (await visible(page, '[data-testid="age-gate"]')) {
      await page.fill('[data-testid="age-year"]', '1990');
      await tapSel(page, '[data-testid="age-continue"]', 1000);
    }
    await page.waitForSelector('[data-testid="boards-offline"]', { timeout: 20000 }).catch(() => fails.push(`${where}: no "can't reach the game server" state without a server`));
    await page.waitForTimeout(500);
    const name = variant === 'en' ? 'leaderboards' : `leaderboards-${variant}`;
    await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
    shots.push(name);
    if (variant === 'zh' && !(await page.evaluate(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-testid="leaderboards"]')?.textContent || '')))) fails.push(`${where}: the page is not in Chinese`);
    fails.push(...(await boardsFit(page)).map((f) => `${where}, daily: ${f}`));
    await tapSel(page, '[data-testid="board-tab-rush"]', 600);
    if (!(await visible(page, '[data-testid="board-period-week"]'))) fails.push(`${where}: the Rush board offers no period choice`);
    fails.push(...(await boardsFit(page)).map((f) => `${where}, rush: ${f}`));
    await ctx.close();
  }
  return { size: `${tag} leaderboards`, finished: true, shots, notes: [], fails, errors };
}

/**
 * Extra-large tiles in landscape: a table at Settings → Display → Tiles: Extra large, a few turns in, captured as
 * <size>-table-xl.png. Fails if the hand rail scrolls sideways (a hand tile off the rail), a hand tile is off screen, or
 * the hand is no larger than a row sharing the rail with my plate (Extra-large moves the plate above the hand).
 */
async function runXL(browser, port, [w, h]) {
  const tag = `${w}x${h}`;
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
    localStorage.setItem('mjm.display', JSON.stringify({ tileScale: 1.5, textScale: 1.3 }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  let discards = 0;
  const started = Date.now();
  while (discards < 5 && Date.now() - started < 90000) {
    if (await visible(page, 'text=Next hand')) break;
    let el;
    if ((el = await visible(page, 'text="過"'))) { await tap(page, el); await page.waitForTimeout(300); continue; }
    if ((el = await visible(page, 'text="打"'))) { await tap(page, el); discards++; await page.waitForTimeout(300); continue; }
    if ((await visible(page, 'text=Tap a tile, tap again to discard')) || (await visible(page, '[data-testid="hand-discard"]'))) {
      const boxes = await page.$$eval('[data-testid^="tile-"]:not([data-testid="tile-back"])', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      const maxW = Math.max(...boxes.map((b) => b.w));
      const hand = boxes.filter((b) => b.w >= maxW * 0.9).sort((a, b) => b.y - a.y || b.x - a.x);
      if (hand[0]) await page.mouse.click(hand[0].x + hand[0].w / 2, hand[0].y + hand[0].h / 2);
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${tag}-table-xl.png`) });
  if (await page.$('[data-testid="hand-scroll"]')) fails.push('extra-large hand scrolls sideways');
  // Every seat tag still fits at Extra-large tiles (side seats on two lines at most).
  fails.push(...(await tableFit(page)).bad.filter((f) => /seat/.test(f)));
  const off = await page.$$eval('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]', (els) =>
    els.filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1; }).length,
  );
  if (off) fails.push(`${off} extra-large hand tiles off screen`);
  // Extra-large moves my plate and melds above the hand, so the row spans the screen: a hand tile at least as wide
  // as 17 tiles across the footer allow (tableFit.ts fitRowTile), or the height cap where that is smaller.
  const tileW = await page.$$eval('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]', (els) => Math.round(Math.min(...els.map((e) => e.getBoundingClientRect().width))));
  const want = Math.min(Math.floor((h * 0.2) / 1.4), Math.floor((w - 24 - 8 - 10 + 2) / 17) - 2);
  if (!(tileW >= want)) fails.push(`extra-large hand tiles are ${tileW} px wide, under the ${want} px a full-width row gives`);
  await ctx.close();
  return { size: `${tag} xl`, finished: true, discards, shots: ['table-xl'], notes: [`hand tile ${tileW} px wide`], fails, errors };
}

/**
 * The Shop's try-on preview, one look of each kind (a tile back the player owns, the rest not), at each viewport and
 * at 320x568, in English and again in Traditional Chinese with reduce motion on (<size>-preview-<kind>.png,
 * <size>-preview-<kind>-zh.png). Hard checks on each: a modal dialog named for the look, inside the screen; no text
 * cut and nothing past the sheet's sides; no two controls overlapping; the title, Close and Buy or Equip rows on
 * screen; Buy on a look not owned and Equip on the owned one; the emote played over the avatar; the celebration's
 * Play again button, or with reduce motion its description instead; the page never scrolling sideways; and focus
 * back on the card's picture once the preview closes.
 */
const PREVIEW_LOOKS = [
  ['table', 'theme.jade'],
  ['tileback', 'back.lotus'],
  ['frame', 'frame.jade'],
  ['emotes', 'emotes.teahouse'],
  ['celebration', 'win.lanterns'],
  ['bundle', 'bundle.dragon'],
];
const PREVIEW_OWNED = 'back.lotus';
const ALL_PREVIEW_SIZES = [...ALL_SIZES, [320, 568]];
const PREVIEW_SIZES = wanted.length ? ALL_PREVIEW_SIZES.filter(([w, h]) => wanted.includes(`${w}x${h}`)) : ALL_PREVIEW_SIZES;

async function previewFit(page) {
  return page.evaluate(() => {
    const bad = [];
    const shown = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const dlg = [...document.querySelectorAll('[data-testid="look-preview"]')].find(shown);
    if (!dlg) return ['the preview is not showing'];
    // One modal dialog, named for the look, holds the sheet: no unnamed outer dialog around a named inner one.
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(shown);
    const named = dlg.closest('[role="dialog"]');
    if (dialogs.length !== 1) bad.push(`${dialogs.length} dialogs on screen, not one (${dialogs.map((d) => `"${d.getAttribute('aria-label') || 'unnamed'}"`).join(', ')})`);
    if (!named || named.getAttribute('aria-modal') !== 'true' || !named.getAttribute('aria-label')) bad.push(`the preview is not in a named modal dialog (aria-modal ${named?.getAttribute('aria-modal')}, label "${named?.getAttribute('aria-label')}")`);
    // The scrim closes on a tap but is no second "Close preview" button: screen readers and the keyboard reach the sheet's own.
    const close = document.querySelector('[data-testid="preview-close"]');
    const closeName = close?.getAttribute('aria-label');
    const reachable = (e) => !e.closest('[aria-hidden="true"]');
    const closers = [...document.querySelectorAll('[role="button"], button')].filter((e) => shown(e) && reachable(e) && closeName && e.getAttribute('aria-label') === closeName);
    if (closers.length !== 1) bad.push(`${closers.length} "${closeName}" buttons reach a screen reader, not one`);
    const scrim = document.querySelector('[data-testid="preview-scrim"]');
    if (scrim && (reachable(scrim) || scrim.tabIndex >= 0)) bad.push('the scrim behind the sheet reaches a screen reader or the keyboard');
    const box = dlg.getBoundingClientRect();
    if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) bad.push(`the sheet runs off the screen (${Math.round(box.left)},${Math.round(box.top)} to ${Math.round(box.right)},${Math.round(box.bottom)} in ${innerWidth}x${innerHeight})`);
    for (const el of dlg.querySelectorAll('div[dir="auto"]')) {
      if (!shown(el) || !el.textContent.trim()) continue;
      const r = el.getBoundingClientRect();
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2) bad.push(`"${el.textContent.slice(0, 30)}" is cut (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`);
      if (r.left < box.left - 1 || r.right > box.right + 1) bad.push(`"${el.textContent.slice(0, 30)}" runs past the sheet's side`);
    }
    for (const sel of ['preview-stage', 'preview-avatar']) for (const el of dlg.querySelectorAll(`[data-testid="${sel}"], [data-testid^="preview-celebration-"]`)) {
      const r = el.getBoundingClientRect();
      if (shown(el) && (r.left < box.left - 1 || r.right > box.right + 1)) bad.push(`the picture is wider than the sheet (${Math.round(r.width)} px in ${Math.round(box.width)})`);
    }
    // Controls: none on top of another (a control inside another is one control).
    const controls = [...dlg.querySelectorAll('[role="button"]')].filter(shown);
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 1 && h > 1) bad.push(`"${a.getAttribute('aria-label') || a.textContent}" overlaps "${b.getAttribute('aria-label') || b.textContent}"`);
      }
    // The title row and the buy row stay on screen, whole, whatever scrolls between them.
    for (const id of ['look-preview-title', 'preview-close', 'preview-buy', 'preview-equip']) {
      const el = [...dlg.querySelectorAll(`[data-testid="${id}"]`)].find(shown);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.right > box.right + 1 || r.bottom > innerHeight + 1) bad.push(`${id} is not whole on screen`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('the page scrolls sideways');
    return bad;
  });
}

async function runPreview(browser, port, [w, h], zh) {
  const tag = `${w}x${h}`;
  const fails = [];
  const errors = [];
  const shots = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: zh ? 'zh-TW' : 'en-US', reducedMotion: zh ? 'reduce' : 'no-preference' });
  await ctx.addInitScript((owned) => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
    localStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
    localStorage.setItem('mjm.wallet', JSON.stringify({ v: 2, userId: null, diamonds: 0, bonusDiamonds: 0, entitlements: [], cosmetics: [owned], clock: { offsetMs: 0, floor: 0 }, syncedAt: null, meters: { day: '', reviews: 0, rush: 0 } }));
  }, PREVIEW_OWNED);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await page.waitForTimeout(500);
  const where = `Shop preview (${zh ? 'zh-TW, reduce motion' : 'en'})`;
  if (!(await tapSel(page, '[data-testid="open-shop"]', 1000)) || !(await tapSel(page, '[data-testid="shop-tab-looks"]', 600))) {
    await ctx.close();
    return { size: `${tag} preview${zh ? '-zh' : ''}`, finished: false, notes: ['the Shop Looks tab did not open'], fails, errors };
  }
  for (const [kind, id] of PREVIEW_LOOKS) {
    const name = `preview-${kind}${zh ? '-zh' : ''}`;
    await tapSel(page, `[data-testid="shelf-${kind === 'celebration' ? 'celebration' : kind}"]`, 400);
    if (!(await tapSel(page, `[data-testid="preview-${id}"]`, 700))) {
      fails.push(`${where}: ${id} has no preview to open`);
      continue;
    }
    if (kind === 'emotes' && !zh) {
      await tapSel(page, '[data-testid="preview-play-th.dumpling"]', 300);
      if (!(await visible(page, '[data-testid="preview-emote-bubble"]'))) fails.push(`${where}: tapping an emote does not play it`);
    }
    if (kind === 'celebration') {
      const replay = await visible(page, '[data-testid="preview-replay"]');
      const still = await visible(page, '[data-testid="preview-celebration-still"]');
      if (zh && (replay || !still)) fails.push(`${where}: with reduce motion the celebration is not described instead of played`);
      if (!zh && (!replay || still)) fails.push(`${where}: the celebration has no Play again button`);
      if (!zh) await page.waitForTimeout(600);
    }
    await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
    shots.push(name);
    fails.push(...(await previewFit(page)).map((f) => `${where} ${id}: ${f}`));
    fails.push(...(await dialogKeys(page)).map((f) => `${where} ${id}, keyboard: ${f}`));
    const owned = id === PREVIEW_OWNED;
    if (owned && !(await visible(page, '[data-testid="preview-equip"]'))) fails.push(`${where}: the owned ${id} offers no Equip`);
    if (!owned && !(await visible(page, '[data-testid="preview-buy"]'))) fails.push(`${where}: ${id} offers no Buy`);
    await tapSel(page, '[data-testid="preview-close"]', 500);
    if (await visible(page, '[data-testid="look-preview"]')) fails.push(`${where}: ${id}'s preview does not close`);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    if (focused !== `preview-${id}`) fails.push(`${where}: focus went to ${focused || 'nothing'}, not back to ${id}'s card, when the preview closed`);
    if (await pageInert(page)) fails.push(`${where}: the Shop stays inert after ${id}'s preview closed`);
  }
  await ctx.close();
  return { size: `${tag} preview${zh ? '-zh' : ''}`, finished: true, shots, notes: [], fails, errors };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  // Large tiles in landscape: the landscape viewports again at Extra-large.
  const XL = SIZES.filter(([w, h]) => w > h);
  // SCREENS_ONLY=preview,xl (say) runs only those groups: table, xl, table-zh, table-zh-xl, home-zh, boards, preview.
  const only = (process.env.SCREENS_ONLY || '').split(',').filter(Boolean);
  const want = (group) => only.length === 0 || only.includes(group);
  const results = await Promise.all([
    ...(want('table') ? SIZES : []).map((s) => run(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]}`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('xl') ? XL : []).map((s) => runXL(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]} xl`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('table-zh') ? SIZES : []).map((s) => runTableZh(browser, port, s, false).catch((e) => ({ size: `${s[0]}x${s[1]} table-zh`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('table-zh-xl') ? SIZES : []).map((s) => runTableZh(browser, port, s, true).catch((e) => ({ size: `${s[0]}x${s[1]} table-zh-xl`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('home-zh') ? SIZES : []).map((s) => runHomeZh(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]} zh-TW`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('boards') ? SIZES : []).map((s) => runBoards(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]} leaderboards`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('preview') ? PREVIEW_SIZES : []).flatMap((s) => [false, true].map((zh) => runPreview(browser, port, s, zh).catch((e) => ({ size: `${s[0]}x${s[1]} preview${zh ? '-zh' : ''}`, finished: false, notes: [e.message], errors: [] })))),
  ]);
  for (const r of results) console.log(JSON.stringify(r));
  await browser.close();
  server.close();
  process.exit(results.every((r) => r.finished && r.errors.length === 0 && (r.fails || []).length === 0) ? 0 : 1);
})().catch((e) => {
  console.error('SCREENS FAIL', e.message);
  process.exit(1);
});

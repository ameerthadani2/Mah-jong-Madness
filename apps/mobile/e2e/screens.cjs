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
 * the exit icon or on the result sheet's "Leave table" leaves the table, a control on the result sheet takes a press under
 * 44 x 44 px or a tap on it reaches another, Start match replaces a saved table
 * without asking, one tap on the Resume card's "Abandon table" gives the saved table up, the English claim buttons carry no gloss, an Extra-large hand scrolls or runs off screen, the
 * Shop does not open, a Home card button clips its label in English or in Traditional Chinese (each viewport, and
 * 320x568, also opens Home in zh-TW and writes <size>-home-zh.png), Home's cards run past the bottom edge at 844x390, the page
 * title is not the app's name in the page's language (Mahjong Mania; 麻將狂熱 in zh-TW, at Home and at the table)), or the
 * leaderboard screen (opened from Learn without a server, in English, zh-TW and Extra-large text: <size>-leaderboards.png,
 * -leaderboards-zh.png, -leaderboards-xl.png) does not show its offline state, clips text or has a choice under 44 px,
 * a table HUD icon takes a press smaller than 44 x 44 px, a control on Home (in English and in zh-TW) or anywhere in
 * Settings takes a press smaller than 44 x 44 px, a tap on a control's face on Home reaches another control (tapsReach), the Shop's Looks tab cuts a description (<size>-shop-looks.png),
 * or Home or Learn in Traditional Chinese draws Chinese in one of the app's Latin faces (thin: latinChinese) or splits a
 * number from its unit in Home's rules line (splitWords; <size>-learn-zh.png),
 * or a seat name is cut at a table in Traditional Chinese (each viewport at Normal text, and the portrait ones again at
 * Extra-large text: <size>-table-zh.png, <size>-table-zh-xl.png at every viewport; the hand tiles' size is logged as a note),
 * or the Shop's try-on preview fails its checks (runPreview below: <size>-preview-<kind>.png and -zh.png, at every
 * viewport and at 320x568), or the coach fails coachCheck at one of my decisions (on screen whenever its button shows it
 * on, a line of its advice whole on screen on my turn and at each claim chance, never covering my pond, my hand, the claim or discard buttons or
 * the tap hint, never cut, "More" beside advice longer than its lines, no Chinese of it in a Latin face, and no scoring
 * term, tile name or number with its unit split across two of its lines) in the whole hand each table run plays: the
 * main run at every viewport, the Extra-large runs, the zh-TW runs, and the coach runs on the smallest phones (568x320,
 * 320x568), at Large tiles at 667x375, on an 11-inch tablet in Traditional Chinese (1194x834, the coach's wider side
 * panel) and on a phone that follows the coach to a win (390x844, seed 22) (<size>-coach-*.png), or the result sheet after
 * my win in those runs puts a star of its ribbon off the title's line (ribbonCheck), or the felt fails feltCheck at one of my decisions in any
 * of those runs (the portrait felt scrolls; an opponent's discard (in landscape the across seat's), the newest of each, my
 * pond, my hand or a claim or discard button is not whole on screen; a button covers a discard; something lies over the
 * top edge of a tile of my hand; a "+N" chip for earlier discards is cut; or the coach's press reaches over my pond or my
 * hand in portrait, or its bar meets my hand in landscape), including the felt runs at Large and Extra-large tiles and text at 390x844, 360x740, 375x667, 360x640 and
 * 320x568, and at Extra-large tiles at 568x320 and 667x375 (<size>-felt-*.png), or the table's discards sheet fails
 * discardsSheetCheck once in each of those hands (a tap on an opponent's seat opens a named modal dialog with that seat first
 * and every one of its discards, those behind a "+N" chip too; <size>-felt-*-discards.png), or the end-of-hand result sheet
 * is not a named modal dialog. The felt and coach runs are seeded (seedContext): each deals the same hand every time, and in
 * landscape the hand follows the coach, so the seeds at 568x320 meet a win offered with Pass and a Chow, a self-drawn win,
 * and Pass, Chow, Pong and Kong at one discard in the narrow dock. SCREENS_SEED=n plays them all on seed n instead; each
 * run's result lists the claim prompts it met. The preview, the exit sheet, Home's
 * replace-table question and the result sheet also fail on the keyboard
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

/**
 * Whether `check()` comes true within `ms` (polled every 100 ms). A sheet slides in or fades out, and the page behind it
 * comes back after it closes, over times a busy machine stretches (all of this file's runs share one browser): a check
 * of how things end up must wait for them rather than look once after a fixed pause.
 */
const until = async (page, check, ms = 3000) => {
  for (let t = 0; ; t += 100) {
    if (await check()) return true;
    if (t >= ms) return false;
    await page.waitForTimeout(100);
  }
};
const shownWithin = (page, sel, ms) => until(page, async () => !!(await visible(page, sel)), ms);
const goneWithin = (page, sel, ms) => until(page, async () => !(await visible(page, sel)), ms);
/**
 * Tap `sel` and wait `wait` ms, as a check always has (the page behind goes inert and the dialog takes the keyboard in
 * that time), then give `target` up to 3 s more to show; one that took longer gets `wait` ms more to settle the same way.
 */
const openWithin = async (page, sel, target, wait) => {
  if (!(await tapSel(page, sel, wait))) return false;
  if (await visible(page, target)) return true;
  if (!(await shownWithin(page, target))) return false;
  await page.waitForTimeout(wait);
  return true;
};

/** Whether the app's root element (everything but a dialog's portal) is inert. */
const pageInert = (page) => page.evaluate(() => !!document.getElementById('root')?.hasAttribute('inert'));
/**
 * Whether a modal dialog other than the one holding `closed` is open: one the page behind must be inert for (each modal
 * sheet's dialog is marked aria-modal, react-native-web's Modal included).
 */
const otherDialogOpen = (page, closed) =>
  page.evaluate(
    (closed) => [...document.querySelectorAll('[aria-modal="true"]')].some((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !d.querySelector(closed); }),
    closed,
  );
/**
 * Whether the page behind the dialog holding `closed`, which just closed, stays inert: it is given up to 3 s to come back
 * (`until`), and a page another modal dialog has opened over meanwhile is inert for that dialog, not stuck. At the table
 * the game goes on under a sheet: when a bot wins while the exit sheet is open, the hand's result sheet (a modal) comes up,
 * and the table is inert until it closes. Counting that page as stuck failed the screens run once at 1024x768 (a hand that
 * ended four discards in); 64 runs of that case, alone and under load, never left the page inert with no dialog open, and
 * every run that held the exit sheet open until the result sheet came up had the page back once the result sheet closed
 * (unit 20f's log).
 */
const staysInert = async (page, closed) => !(await until(page, async () => !(await pageInert(page)) || (await otherDialogOpen(page, closed))));

/**
 * A browser context whose pages draw Math.random and crypto.getRandomValues from one seeded generator (mulberry32), so a
 * run deals the same hand every time; the bots' choices follow from the deal, and playCoachedHand's are fixed (it passes
 * every claim and discards the lowest, right-most tile). A run is then the same hand on every build that draws the same
 * numbers, unless a machine so busy that a turn clock runs out plays a tile for it. SCREENS_SEED=n gives every seeded run
 * that seed instead (to look for a hand that meets a given case: each run's result lists the claim prompts it met).
 */
const SEED_OVERRIDE = process.env.SCREENS_SEED ? Number(process.env.SCREENS_SEED) : null;
const seedContext = (ctx, seed) =>
  ctx.addInitScript((seed) => {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    Math.random = next;
    const fill = (arr) => {
      const max = 2 ** (8 * (arr.BYTES_PER_ELEMENT || 1));
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(next() * max);
      return arr;
    };
    Object.defineProperty(crypto, 'getRandomValues', { value: fill, configurable: true, writable: true });
  }, SEED_OVERRIDE ?? seed);

/**
 * An open dialog's keyboard checks: the page behind it is inert, and Tab (`tabs` times) then Shift+Tab (4 times) move
 * focus only through the dialog's own controls, never to the scrim, to something hidden from screen readers or to the
 * page behind. Reads document.activeElement after every key.
 */
async function dialogKeys(page, tabs = 10) {
  const bad = [];
  if (!(await until(page, () => pageInert(page)))) bad.push('the page behind the dialog is not inert');
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

/** The result sheet's button labels, each whole inside its button (a label wider than its button is cut at both ends). */
async function sheetLabels(page) {
  return page.evaluate(() => {
    const sheet = [...document.querySelectorAll('[data-testid="result-sheet"]')].find((e) => e.getBoundingClientRect().width > 0);
    if (!sheet) return [];
    const bad = new Set();
    for (const b of sheet.querySelectorAll('[role="button"]')) {
      const br = b.getBoundingClientRect();
      for (const t of b.querySelectorAll('div[dir="auto"]')) {
        const r = t.getBoundingClientRect();
        if (r.width === 0 || !t.textContent.trim()) continue;
        if (t.scrollWidth > t.clientWidth + 1 || r.left < br.left - 1 || r.right > br.right + 1) bad.add(`the result sheet's "${t.textContent.trim().slice(0, 24)}" is cut (${Math.round(r.width)} px of label in a ${Math.round(br.width)} px button)`);
      }
    }
    return [...bad];
  });
}

/**
 * The end-of-hand result sheet's hard checks: it is inside one named modal dialog (aria-modal, a name), and dialogKeys
 * passes on it (the table behind it inert, Tab and Shift+Tab only through its own buttons).
 */
async function resultModal(page) {
  const bad = [];
  const dialog = await page.evaluate(() => {
    const sheet = [...document.querySelectorAll('[data-testid="result-sheet"]')].find((e) => e.getBoundingClientRect().width > 0);
    const d = sheet?.closest('[role="dialog"]');
    return sheet ? { inDialog: !!d, modal: d?.getAttribute('aria-modal') ?? null, name: d?.getAttribute('aria-label') ?? '' } : null;
  });
  if (!dialog) return ['the result sheet is not showing'];
  if (!dialog.inDialog || dialog.modal !== 'true' || !dialog.name.trim()) bad.push(`it is not in a named modal dialog (aria-modal ${dialog.modal}, name "${dialog.name}")`);
  bad.push(...(await dialogKeys(page)));
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

/**
 * Every control on the page as it stands (Home, or all of Settings, on screen or scrolled out of view) takes a press of
 * at least 44 x 44 px. The web ignores hitSlop, so the box itself must be that big: a control drawn smaller is padded
 * to it, with an equal negative margin that keeps its place (Ui.tsx `webPress`, as IconButton does).
 */
async function pressTargets(page) {
  return page.evaluate(() => {
    const sel = '[role="button"], button, a[href], [role="link"], [role="tab"], [role="switch"], [role="radio"], [role="checkbox"]';
    const shown = [...document.querySelectorAll(sel)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !e.closest('[aria-hidden="true"]') && !e.closest('[inert]');
    });
    return shown
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; })
      .map((e) => {
        const r = e.getBoundingClientRect();
        const name = (e.getAttribute('aria-label') || e.textContent || e.dataset.testid || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 28);
        return `"${name}" is a ${Math.round(r.width)}x${Math.round(r.height)} px press, under 44`;
      });
  });
}

/**
 * A tap anywhere on a control's drawn face reaches that control, never another control whose press reaches over it (a
 * padded press, Ui.tsx webPress, drawn after it). Samples every control on screen across its face (its box less the
 * padding that pads its press), every 2 px down and at five points across.
 */
async function tapsReach(page) {
  return page.evaluate(() => {
    const sel = '[role="button"], button, a[href], [role="link"], [role="tab"], [role="switch"], [role="radio"], [role="checkbox"]';
    const controls = [...document.querySelectorAll(sel)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !e.closest('[aria-hidden="true"]') && !e.closest('[inert]');
    });
    const name = (e) => (e.getAttribute('aria-label') || e.textContent || e.dataset.testid || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 28);
    const bad = new Map();
    for (const c of controls) {
      const r = c.getBoundingClientRect();
      const st = getComputedStyle(c);
      const face = { top: r.top + parseFloat(st.paddingTop), bottom: r.bottom - parseFloat(st.paddingBottom), left: r.left + parseFloat(st.paddingLeft), right: r.right - parseFloat(st.paddingRight) };
      for (let y = Math.max(0, Math.ceil(face.top)) + 0.5; y < Math.min(face.bottom, innerHeight); y += 2)
        for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const x = face.left + (face.right - face.left) * fx;
          if (x < 0 || x >= innerWidth) continue;
          const owner = document.elementFromPoint(x, y)?.closest(sel);
          if (owner && owner !== c && !c.contains(owner) && !owner.contains(c)) {
            const k = `a tap on "${name(c)}" reaches "${name(owner)}"`;
            if (!bad.has(k)) bad.set(k, Math.round(y - face.top));
          }
        }
    }
    return [...bad].map(([k, y]) => `${k} (${y} px down its face)`);
  });
}

/** Home in Traditional Chinese at one viewport: the same hard checks, on the longer of the two languages' labels. */
/**
 * The table's hard checks, on the page as it stands: every seat name shown whole (a long one may take two lines,
 * never be cut), a landscape side seat's tag on two lines at most (name; relation and score), and each HUD icon (emotes,
 * coach, exit) a press of at least 44 x 44 px (the coach itself has coachCheck, below). The web ignores hitSlop,
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
    return { bad, tile };
  });
}

/**
 * The coach's hard checks, on the page as it stands at one of my decisions (`advised`: my turn to discard, a win, or a
 * claim chance, where the coach always has advice: the win, the tile to discard, the claim to make, or Pass with why).
 * Whenever the coach is on (the HUD's cap button selected) it is on screen; at those decisions a line of its advice is
 * whole on screen: inside the window and every box that clips it, and the topmost thing where it is drawn; any advice it
 * shows is; the coach is
 * never cut by the window or a box around it, and never covers my pond, my hand, the claim or discard buttons or the tap
 * hint (as drawn: what the felt clips away does not count); and advice longer than its lines ends in an ellipsis with
 * "More" beside it, never cut without a sign.
 */
async function coachCheck(page, advised) {
  return page.evaluate((advised) => {
    const bad = [];
    const seen = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const clipOf = (el) => {
      let c = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (st.overflowY !== 'visible' || st.overflowX !== 'visible') {
          const r = p.getBoundingClientRect();
          c = { top: Math.max(c.top, r.top), left: Math.max(c.left, r.left), bottom: Math.min(c.bottom, r.bottom), right: Math.min(c.right, r.right) };
        }
      }
      return c;
    };
    const shown = (el) => { const r = el.getBoundingClientRect(); const c = clipOf(el); return { top: Math.max(r.top, c.top), left: Math.max(r.left, c.left), bottom: Math.min(r.bottom, c.bottom), right: Math.min(r.right, c.right) }; };
    const meet = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const leave = document.querySelector('[data-testid="leave-table"]');
    const icons = leave ? [...leave.parentElement.querySelectorAll('[role="button"]')] : [];
    const cap = icons.length >= 3 ? icons[icons.length - 2] : null;
    const on = cap?.getAttribute('aria-selected') === 'true';
    // The bar as drawn (its press reaches past it on the web, as hitSlop does on a phone), and what of it is not clipped away.
    const face = (c) => c.querySelector('[data-testid="coach-face"]') ?? c;
    const onScreen = (e) => { const b = shown(e); return b.bottom - b.top > 1 && b.right - b.left > 1; };
    const coaches = [...document.querySelectorAll('[data-testid="coach"]')].filter(seen);
    if (on && !coaches.some((c) => onScreen(face(c)))) bad.push("the coach is on (its button is selected) but not on screen");
    // A line of advice is whole on screen: inside every clipping box, and nothing drawn over it at that line.
    const whole = (a) => {
      const r = a.getBoundingClientRect();
      const st = getComputedStyle(a);
      const line = Math.min(r.height, parseFloat(st.lineHeight) || parseFloat(st.fontSize) * 1.3);
      const c = clipOf(a);
      if (r.top < c.top - 1 || r.top + line > c.bottom + 1 || r.left < c.left - 1 || r.left + 20 > c.right + 1) return false;
      const y = r.top + line / 2;
      return [r.left + 4, (r.left + Math.min(r.right, c.right)) / 2].every((x) => { const hit = document.elementFromPoint(x, y); return !!hit && (a.contains(hit) || hit.contains(a)); });
    };
    const advice = [...document.querySelectorAll('[data-testid="coach-advice"]')].filter(seen);
    for (const a of advice) {
      if (!a.textContent.trim()) continue;
      if (!whole(a)) bad.push(`the coach's advice "${a.textContent.slice(0, 30)}" has no line whole on screen`);
      // Cut by its own lines (an ellipsis), or by a box around it (a scroll box, the felt) past its first line.
      const r = a.getBoundingClientRect();
      const k = clipOf(a);
      const boxed = r.bottom > k.bottom + 1 || r.right > k.right + 1;
      const cut = a.scrollHeight > a.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1 || boxed;
      const more = [...document.querySelectorAll('[data-testid="coach-more"]')].some(seen);
      if (cut && !more) bad.push(`the coach's advice "${a.textContent.slice(0, 30)}" is cut${boxed ? ' by a box around it' : ''} with no More to read the rest`);
    }
    // The bar, and the panel's More, take a 44 pt press on the web too, where hitSlop does nothing (DESIGN.md).
    for (const b of [...coaches, ...document.querySelectorAll('[data-testid="coach-more"][role="button"]')].filter(seen)) {
      const r = b.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) bad.push(`the coach's ${b.dataset.testid === 'coach' ? 'bar' : 'More button'} is a ${Math.round(r.width)}x${Math.round(r.height)} px press, under 44`);
    }
    if (on && advised && coaches.length > 0 && !advice.some((a) => a.textContent.trim() && whole(a))) bad.push('at my decision (my turn, a win or a claim chance) the coach shows no line of advice whole on screen');
    for (const c of coaches.map(face)) {
      const r = c.getBoundingClientRect();
      const k = clipOf(c);
      if (r.top < k.top - 1 || r.bottom > k.bottom + 1 || r.left < k.left - 1 || r.right > k.right + 1) bad.push(`the coach is cut (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} inside ${Math.round(k.left)},${Math.round(k.top)} to ${Math.round(k.right)},${Math.round(k.bottom)})`);
      const box = shown(c);
      const hits = (sel) => [...document.querySelectorAll(sel)].filter(seen).some((e) => meet(box, shown(e)));
      if (hits('[data-testid="my-pond"] [data-testid^="tile-"]')) bad.push('the coach covers my pond');
      if (hits('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]')) bad.push('the coach covers my hand');
      if (hits('[data-testid="action-dock"] [role="button"], [data-testid="action-strip"] [role="button"]')) bad.push('the coach covers the claim or discard buttons');
      const hint = [...document.querySelectorAll('div[dir="auto"]')].find((e) => /^(Tap a tile, tap again to discard|點一張牌，再點一次打出)$/.test(e.textContent) && seen(e));
      if (hint && meet(box, shown(hint.parentElement))) bad.push('the coach covers the tap hint');
    }
    return bad;
  }, advised);
}

/**
 * Chinese drawn in one of the app's Latin faces (Lilita, Luckiest, Fredoka, Nunito), which have no Chinese glyphs: the
 * browser falls back to its regular weight, thin beside the heavy titles (the showcase review of 20 November). The app's
 * Text names the system's Chinese face for it instead (src/components/Text.tsx). Each such text, with its face, under
 * `sel` (the whole page by default).
 */
const latinChinese = (page, sel = null) =>
  page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document.body;
    if (!root) return [];
    const out = new Set();
    for (const el of root.querySelectorAll('div, span')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
      if (!/[\u3400-\u9fff]/.test(own) || el.getBoundingClientRect().width === 0) continue;
      const face = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
      if (/^(Lilita|Luckiest|Fredoka|Nunito)/.test(face)) out.add(`"${own.trim().slice(0, 16)}" in ${face}`);
    }
    return [...out];
  }, sel);

/**
 * What a line must not split (src/logic/keepWhole.ts): a scoring term, a Chinese tile name, a number and its unit. Each
 * occurrence in the text under `sel` that is drawn on two lines, measured from its own glyphs.
 */
const KEEP_WHOLE = ['門清自摸', '槓上開花', '花上自摸', '海底撈月', '河底撈魚', '八仙過海', '嚦咕嚦咕', '碰碰胡', '全求人', '半求人', '三暗刻', '四暗刻', '五暗刻', '混一色', '清一色', '字一色', '小三元', '大三元', '小四喜', '大四喜', '搶槓', '平胡', '獨聽', '門清', '自摸', '莊家', '連莊', '放槍', '胡牌', '聽牌', '覆盤', '俱樂部', '么九'];
const splitWords = (page, sel) =>
  page.evaluate(
    ([sel, terms]) => {
      const words = new RegExp([...terms.map((w) => [...w].join('\u2060?')), '[一二三四五六七八九]\u2060?[萬筒條]', '[一兩二三四五六七八九十](?:\u2060?[一二三四五六七八九十])*\u2060?(?:圈|將|組|張)', '\\d[ \u00a0\u2060]?(?:台|秒|張|局|點|分|組|步|課)', '[萬筒條風中發白]\u2060?×\u2060?\\d'].join('|'), 'g');
      const out = new Set();
      for (const root of document.querySelectorAll(sel)) {
        if (root.getBoundingClientRect().width === 0) continue;
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.parentElement.closest('[aria-hidden="true"]')) continue;
          words.lastIndex = 0;
          for (let m; (m = words.exec(n.textContent)); ) {
            const range = document.createRange();
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
            if (tops.size > 1) out.add(`"${m[0].replace(/\u2060/g, '')}" is split across two lines in "${n.textContent.replace(/\u2060/g, '').slice(0, 24)}…"`);
          }
        }
      }
      return [...out];
    },
    [sel, KEEP_WHOLE],
  );

/**
 * The result sheet's ribbon after my win: both stars on the title's line (the showcase review of 20 November: at phone
 * width the closing ☆ wrapped onto a line of its own). Nothing to look at after a draw or another seat's win.
 */
const ribbonCheck = (page) =>
  page.evaluate(() => {
    const seen = (e) => e.getBoundingClientRect().width > 0;
    const sheet = [...document.querySelectorAll('[data-testid="result-sheet"]')].find(seen);
    const ribbon = sheet && [...sheet.querySelectorAll('[role="heading"]')].find(seen);
    if (!ribbon) return [];
    const stars = [...ribbon.querySelectorAll('svg')].filter(seen);
    if (stars.length === 0) return [];
    // The title: the ribbon's largest text.
    const texts = [...ribbon.querySelectorAll('div[dir="auto"]')].filter((e) => seen(e) && e.textContent.trim() && e.closest('[aria-hidden="true"]') === null);
    const title = texts.sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize))[0];
    if (!title) return ['the result ribbon has no title'];
    const t = title.getBoundingClientRect();
    const mid = (r) => (r.top + r.bottom) / 2;
    return stars.filter((s) => Math.abs(mid(s.getBoundingClientRect()) - mid(t)) > t.height / 2).map((s) => `a star of the result ribbon sits off the title's line (its middle at ${Math.round(mid(s.getBoundingClientRect()))}, the title's at ${Math.round(mid(t))})`);
  });

/**
 * coachCheck once the table has settled: a finding is kept only if it is still there after two more looks 800 ms apart (a
 * new line is laid out a frame after it shows, later on a busy machine).
 */
async function coachSettled(page, advised) {
  const look = async () => [...(await coachCheck(page, advised)), ...(await latinChinese(page, '[data-testid="coach"]')).map((f) => `the coach draws ${f}`), ...(await splitWords(page, '[data-testid="coach"]')).map((f) => `the coach: ${f}`)];
  let found = await look();
  for (let i = 0; i < 2 && found.length > 0; i++) {
    await page.waitForTimeout(800);
    found = await look();
  }
  return found;
}

/**
 * The felt's hard checks at one of my decisions, on the page as it stands. Whole on screen means inside the window and
 * every box that clips it, with nothing drawn over it (the topmost thing at five points of it is the element).
 * - Portrait: nothing on the felt scrolls, and every discard of every opponent is whole on screen, so the newest of each
 *   is too. Landscape: the newest discard of each opponent is whole on screen, and every discard of the across seat (a
 *   side seat's column may scroll its older rows out of view).
 * - No claim or discard button covers any part of a discard on screen.
 * - A pond that keeps only its newest rows (display/portraitFit.ts, and fitCompactCentre on a short landscape phone)
 *   says how many it leaves out with a "+N" chip, whole on screen too.
 * - Every tile of an opponent's melds and flowers is whole on screen (none scrolled away or under its plate), and in
 *   portrait a side seat's tiles stay inside its column.
 * - The "X discarded Y" line under the compass is not cut, and no seat's plate is drawn over another's name tag.
 * - Every tile of my pond and of my hand (the raised one too) and every claim or discard button is whole on screen, and
 *   nothing lies over the top edge of a tile of my hand (the coach's press over a raised tile took the tap there).
 * - Portrait: the coach's press (on the web, padded where its bar is short) reaches over no tile of my pond or my hand.
 *   Landscape: the coach's bar (over the hand) meets no tile of my hand.
 */
async function feltCheck(page) {
  return page.evaluate(() => {
    const bad = [];
    const portrait = innerHeight > innerWidth;
    const seen = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const clipOf = (el) => {
      let c = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (st.overflowY !== 'visible' || st.overflowX !== 'visible') {
          const r = p.getBoundingClientRect();
          c = { top: Math.max(c.top, r.top), left: Math.max(c.left, r.left), bottom: Math.min(c.bottom, r.bottom), right: Math.min(c.right, r.right) };
        }
      }
      return c;
    };
    // Drawn over: the topmost thing at five points of the box is not the element or inside it.
    const under = (el, b) => [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].some(([fx, fy]) => {
      const hit = document.elementFromPoint(b.left + (b.right - b.left) * fx, b.top + (b.bottom - b.top) * fy);
      return !hit || !(el.contains(hit) || hit.contains(el));
    });
    const whole = (el) => {
      const r = el.getBoundingClientRect();
      const c = clipOf(el);
      return r.top >= c.top - 1 && r.bottom <= c.bottom + 1 && r.left >= c.left - 1 && r.right <= c.right + 1 && !under(el, r);
    };
    // The part of a box left on screen by the boxes that clip it.
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const c = clipOf(el);
      return { top: Math.max(r.top, c.top), left: Math.max(r.left, c.left), bottom: Math.min(r.bottom, c.bottom), right: Math.min(r.right, c.right) };
    };
    const meet = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const BUTTONS = '[data-testid="action-dock"] [role="button"], [data-testid="action-strip"] [role="button"]';
    const buttons = [...document.querySelectorAll(BUTTONS)].filter(seen).map(shown);
    const felt = portrait && document.querySelector('[data-testid="felt-portrait"]');
    if (felt) {
      for (const e of [felt, ...felt.querySelectorAll('div')]) {
        const st = getComputedStyle(e);
        if (/auto|scroll/.test(`${st.overflowY} ${st.overflowX}`) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)) {
          bad.push('the felt scrolls (its content is taller than the felt)');
          break;
        }
      }
    }
    for (const pond of document.querySelectorAll('[data-testid^="pond-seat-"]')) {
      const who = `${pond.dataset.testid.replace('pond-seat-', 'the ').replace(/1$/, 'right seat').replace(/2$/, 'across seat').replace(/3$/, 'left seat')}'s pond`;
      const tiles = [...pond.querySelectorAll('[data-testid^="tile-"]')].filter(seen);
      if (!tiles.length) continue;
      if (!whole(tiles[tiles.length - 1])) bad.push(`${who}: its newest discard is not whole on screen`);
      if ((portrait || pond.dataset.testid === 'pond-seat-2') && tiles.some((t) => !whole(t))) bad.push(`${who}: discards not whole on screen`);
      const covered = tiles.map(shown).filter((s) => s.bottom - s.top > 1 && s.right - s.left > 1 && buttons.some((b) => meet(b, s)));
      if (covered.length) bad.push(`${who}: the claim or discard buttons cover its discards`);
      const chip = pond.querySelector('[data-testid="pond-earlier"]');
      if (chip && !whole(chip)) bad.push(`${who}: the chip for its earlier discards is not whole on screen`);
    }
    // An opponent's melds and flowers (its seat's face-up tiles outside its pond) are whole on screen: they never scroll
    // or sit under its plate, whatever its pond gives up.
    for (const seat of document.querySelectorAll('[data-testid^="seat-press-"]')) {
      const who = `the ${{ 1: 'right', 2: 'across', 3: 'left' }[seat.dataset.testid.slice(-1)]} seat`;
      const melds = [...seat.querySelectorAll('[data-testid^="tile-"]')].filter((t) => t.dataset.testid !== 'tile-back' && !t.closest('[data-testid^="pond-seat-"]') && !t.parentElement.closest('[data-testid^="tile-"]') && seen(t));
      if (melds.some((t) => !whole(t))) bad.push(`${who}'s melds: not whole on screen`);
    }
    // Portrait: a side seat's tiles (a kong with its claimed tile on its side among them) stay inside its column.
    if (portrait)
      for (const r of [1, 3]) {
        const col = document.querySelector(`[data-testid="seat-press-${r}"]`);
        if (!col) continue;
        const cb = col.getBoundingClientRect();
        const out = [...col.querySelectorAll('[data-testid^="tile-"]')].filter(seen).filter((t) => {
          const b = t.getBoundingClientRect();
          return b.left < cb.left - 1 || b.right > cb.right + 1;
        });
        if (out.length) bad.push(`the ${r === 1 ? 'right' : 'left'} seat's tiles run past its column`);
      }
    // No seat's plate is drawn over another seat's name tag (the across seat's, between the side seats' plates in portrait).
    for (const plate of document.querySelectorAll('[data-testid^="plate-seat-"]')) {
      const tag = plate.querySelector('[data-testid="seat-tag"], [data-testid="seat-tag-side"]');
      if (!tag || !seen(tag)) continue;
      const b = tag.getBoundingClientRect();
      let over = null;
      for (let y = b.top + 2; y < b.bottom - 1 && !over; y += 3)
        for (let x = b.left + 2; x < b.right - 1 && !over; x += 3) {
          const other = document.elementFromPoint(x, y)?.closest('[data-testid^="plate-seat-"]');
          if (other && other !== plate) over = other.dataset.testid;
        }
      if (over) bad.push(`${plate.dataset.testid}'s name tag is under ${over}`);
    }
    // The "X discarded Y" line under the compass says the whole of it (it takes a second line rather than being cut).
    for (const t of [...document.querySelectorAll('[data-testid="table-status"] div[dir="auto"]')].filter(seen)) {
      if (t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1) bad.push(`the status line is cut ("${t.textContent.slice(0, 40)}")`);
    }
    const MY_POND = '[data-testid="my-pond"] [data-testid^="tile-"]';
    const HAND = '[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]';
    for (const [what, sel] of [['my pond', MY_POND], ['my hand', HAND], ['the claim or discard buttons', BUTTONS]]) {
      const els = [...document.querySelectorAll(sel)].filter(seen);
      const cut = els.filter((e) => !whole(e));
      if (cut.length) bad.push(`${what}: not whole on screen`);
    }
    // A tap anywhere on a tile of my hand takes it: nothing lies over its top edge either (2 px in), where a raised
    // tile meets the press of the coach's bar above it.
    const topEdgeCovered = (el) => {
      const r = el.getBoundingClientRect();
      return [0.25, 0.5, 0.75].some((fx) => {
        const hit = document.elementFromPoint(r.left + r.width * fx, r.top + 2);
        return !hit || !(el.contains(hit) || hit.contains(el));
      });
    };
    if ([...document.querySelectorAll(HAND)].filter(seen).some(topEdgeCovered)) bad.push("my hand: something lies over a tile's top edge (a tap there misses it)");
    for (const c of [...document.querySelectorAll('[data-testid="coach"]')].filter(seen)) {
      if (portrait) {
        const box = c.getBoundingClientRect();
        for (const [what, sel] of [['my pond', MY_POND], ['my hand', HAND]]) {
          const n = [...document.querySelectorAll(sel)].filter(seen).filter((t) => meet(box, t.getBoundingClientRect())).length;
          if (n) bad.push(`the coach's press reaches over ${what}`);
        }
      } else {
        const face = (c.querySelector('[data-testid="coach-face"]') || c).getBoundingClientRect();
        if ([...document.querySelectorAll(HAND)].filter(seen).some((t) => meet(face, t.getBoundingClientRect()))) bad.push("the coach's bar meets my hand");
      }
    }
    return bad;
  });
}

/**
 * feltCheck once the table has settled: a finding is kept only if it is still there after two more looks 800 ms apart (a
 * discard slides in, and a row is laid out a frame late, both slower on a busy machine).
 */
async function feltSettled(page) {
  let found = await feltCheck(page);
  for (let i = 0; i < 2 && found.length > 0; i++) {
    await page.waitForTimeout(800);
    found = await feltCheck(page);
  }
  return found;
}

/**
 * The table's discards sheet, from an opponent's seat on the felt (`r`: 1 right, 2 across, 3 left): a tap on the seat opens
 * it, a named modal dialog with that seat first and every one of its discards (those the felt shows and those its "+N" chip
 * counts), the newest last; dialogKeys passes on it; Escape closes it and the table is no longer inert.
 */
async function discardsSheetCheck(page, r, shot) {
  const who = r === 1 ? 'the right seat' : r === 2 ? 'the across seat' : 'the left seat';
  const bad = [];
  const felt = await page.evaluate((r) => {
    const pond = document.querySelector(`[data-testid="pond-seat-${r}"]`);
    const tiles = pond ? [...pond.querySelectorAll('[data-testid^="tile-"]')].filter((t) => t.getBoundingClientRect().width > 0) : [];
    const chip = pond?.querySelector('[data-testid="pond-earlier"]');
    return { shown: tiles.length, earlier: chip ? Number(chip.textContent.replace(/\D/g, '')) : 0, newest: tiles.length ? tiles[tiles.length - 1].dataset.testid : null };
  }, r);
  const seat = await visible(page, `[data-testid="seat-press-${r}"]`);
  if (!seat || (await seat.getAttribute('role')) !== 'button') return [`${who} is not a button that opens the table's discards`];
  await tap(page, seat);
  let open = false;
  for (let t = 0; t < 30 && !open; t++) {
    await page.waitForTimeout(100);
    open = !!(await visible(page, '[data-testid="discards-sheet"]'));
  }
  if (!open) return [`a tap on ${who} did not open the table's discards`];
  await page.waitForTimeout(400);
  if (shot) await page.screenshot({ path: shot });
  const sheet = await page.evaluate((r) => {
    const s = document.querySelector('[data-testid="discards-sheet"]');
    const d = s?.closest('[role="dialog"]');
    const pond = document.querySelector(`[data-testid="discards-pond-${r}"]`);
    const tiles = pond ? [...pond.querySelectorAll('[data-testid^="tile-"]')] : [];
    const box = s ? s.getBoundingClientRect() : null;
    const off = box && (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1);
    return { modal: d?.getAttribute('aria-modal') ?? null, name: d?.getAttribute('aria-label') ?? '', n: tiles.length, last: tiles.length ? tiles[tiles.length - 1].dataset.testid : null, first: document.querySelector('[data-testid^="discards-seat-"]')?.dataset.testid ?? null, off };
  }, r);
  if (sheet.modal !== 'true' || !sheet.name.trim()) bad.push(`the discards sheet is not a named modal dialog (aria-modal ${sheet.modal}, name "${sheet.name}")`);
  if (sheet.off) bad.push('the discards sheet runs off the screen');
  if (sheet.first !== `discards-seat-${r}`) bad.push(`the discards sheet does not start with ${who}`);
  if (sheet.n !== felt.shown + felt.earlier) bad.push(`the discards sheet shows ${sheet.n} of ${who}'s ${felt.shown + felt.earlier} discards`);
  if (felt.newest && sheet.last !== felt.newest) bad.push(`the discards sheet does not end with ${who}'s newest discard`);
  bad.push(...(await dialogKeys(page)).map((f) => `the discards sheet: ${f}`));
  await page.keyboard.press('Escape');
  for (let t = 0; t < 30 && open; t++) {
    await page.waitForTimeout(100);
    open = !!(await visible(page, '[data-testid="discards-sheet"]'));
  }
  if (open) bad.push('Escape did not close the discards sheet');
  if (await staysInert(page, '[data-testid="discards-sheet"]')) bad.push('the table stays inert after the discards sheet closed');
  return bad.map((f) => `${f} (${felt.shown} shown, ${felt.earlier} behind the chip)`);
}

/**
 * Which opponent's discards sheet to check at this decision: the first seat whose pond has a "+N" chip; with `any`, the
 * opponent with the most discards (null when none has one yet).
 */
const sheetSeat = (page, any) =>
  page.evaluate((any) => {
    const ponds = [1, 2, 3].map((r) => {
      const p = document.querySelector(`[data-testid="pond-seat-${r}"]`);
      return { r, chip: !!p?.querySelector('[data-testid="pond-earlier"]'), n: p ? p.querySelectorAll('[data-testid^="tile-"]').length : 0 };
    });
    const chipped = ponds.find((p) => p.chip);
    if (chipped) return chipped.r;
    const most = [...ponds].sort((a, b) => b.n - a.n)[0];
    return any && most.n > 0 ? most.r : null;
  }, any);

/** Problems found at more than one decision, said once each with the number of decisions they were seen at. */
function tally(found) {
  const n = new Map();
  for (const f of found) n.set(f, (n.get(f) ?? 0) + 1);
  return [...n].map(([f, k]) => (k > 1 ? `${f} (at ${k} decisions)` : f));
}

/**
 * Plays my seat through one whole hand (until the result sheet, or `untilDiscards` of my discards), passing every claim
 * and discarding the lowest, right-most tile (the drawn one in landscape), and runs coachCheck and feltCheck at each of my
 * decisions: my turn before and after a tile is picked, a win, and each claim chance; and discardsSheetCheck once (a
 * screenshot of the sheet to `sheetShot`, when given). It fails, too, when my hand's tiles get smaller between two of my
 * decisions without the table's "Tiles made smaller" notice, when an opponent shows fewer meld tiles at one of my
 * decisions than at the one before (the felt hid some), or when, with several 吃 choices open, there is no Pass among
 * them or the row is not whole on screen. `onDiscard(n)` runs after my nth discard. With `discard`
 * 'coach' it discards the tile the coach rings instead, so the hand heads for a win and win prompts come up.
 */
async function playCoachedHand(page, { onDiscard = async () => undefined, untilDiscards = Infinity, limitMs = 240000, sheetShot = null, discard = 'last' } = {}) {
  const found = [];
  let discards = 0;
  // The table's discards sheet, once a hand: at my first turn where an opponent's pond has a "+N" chip, or else at my
  // turn after my sixth discard (discardsSheetCheck).
  let sheetChecked = false;
  // My hand's tile size at each of my decisions (I never meld here, so only the table can change it): it never gets
  // smaller between two of them unless the table said so, its "Tiles made smaller" notice seen in between.
  let handW = null;
  let toldSmaller = false;
  // The notice stays 5 s. With every run of this file sharing one browser, the checks at a decision can take longer than
  // that, so polling for it between two decisions misses it now and then. The page notes each time it draws the notice
  // instead, and the check at each decision reads and clears that note (`smallerDrawn`).
  await page.evaluate(() => {
    const note = () => {
      if (document.querySelector('[data-testid="tiles-smaller-notice"]')) window.__mjmTilesSmaller = true;
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true, characterData: true });
    note();
  });
  const smallerDrawn = () =>
    page.evaluate(() => {
      const drawn = !!window.__mjmTilesSmaller;
      window.__mjmTilesSmaller = false;
      return drawn;
    });
  // Each opponent's melds and flowers on the felt (its face-up tiles outside its pond): they only ever grow in a hand, so
  // fewer at one of my decisions than at the one before means the felt hid some.
  const meldsSeen = {};
  // The claim prompts met (the buttons on offer at each), for the run's result: which cases a seeded hand covers.
  const prompts = [];
  const promptSeen = async () =>
    prompts.push(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="action-dock"] [role="button"], [data-testid="action-strip"] [role="button"]')]
          .filter((b) => b.getBoundingClientRect().width > 0)
          .map((b) => (b.getAttribute('aria-label') || '').split(':')[0])
          .join('+'),
      ),
    );
  const decision = async () => {
    found.push(...(await coachSettled(page, true)), ...(await feltSettled(page)));
    const w = await page.evaluate(() => {
      const t = [...document.querySelectorAll('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]')].find((e) => e.getBoundingClientRect().width > 0);
      return t ? Math.round(t.getBoundingClientRect().width) : null;
    });
    const drawn = await smallerDrawn();
    if (w !== null && handW !== null && w < handW - 1 && !toldSmaller && !drawn && !(await visible(page, '[data-testid="tiles-smaller-notice"]'))) found.push(`my hand's tiles got smaller between two of my decisions (${handW} to ${w} px) and the table did not say so`);
    if (w !== null) handW = w;
    toldSmaller = false;
    const melds = await page.evaluate(() =>
      Object.fromEntries(
        [1, 2, 3].map((r) => {
          const seat = document.querySelector(`[data-testid="seat-press-${r}"]`);
          const tiles = seat ? [...seat.querySelectorAll('[data-testid^="tile-"]')].filter((t) => t.dataset.testid !== 'tile-back' && !t.closest('[data-testid^="pond-seat-"]') && !t.parentElement.closest('[data-testid^="tile-"]') && t.getBoundingClientRect().width > 0) : [];
          return [r, tiles.length];
        }),
      ),
    );
    for (const r of [1, 2, 3]) {
      if (meldsSeen[r] !== undefined && melds[r] < meldsSeen[r]) found.push(`the ${{ 1: 'right', 2: 'across', 3: 'left' }[r]} seat's melds went from ${meldsSeen[r]} tiles to ${melds[r]} between two of my decisions`);
      meldsSeen[r] = Math.max(meldsSeen[r] ?? 0, melds[r]);
    }
  };
  const started = Date.now();
  while (Date.now() - started < limitMs && discards < untilDiscards) {
    if ((await visible(page, '[data-testid="result-sheet"]')) || (await visible(page, 'text=/^(Next hand|下一局)/'))) break;
    if (await visible(page, '[data-testid="tiles-smaller-notice"]')) toldSmaller = true;
    let el;
    if ((el = await visible(page, '[data-testid="claim-win"]'))) {
      await decision();
      await promptSeen();
      await tap(page, el);
      await page.waitForTimeout(400);
      continue;
    }
    if ((el = await visible(page, '[data-testid="claim-pass"]'))) {
      await decision();
      await promptSeen();
      // Several 吃 choices behind one 吃 button: open them. Pass is there too (the coach's advice may be Pass), and the
      // row is whole on screen; then pass from it.
      const chiOpen = await visible(page, '[data-testid="claim-chi-open"]');
      if (chiOpen) {
        await tap(page, chiOpen);
        await page.waitForTimeout(400);
        const pass = await visible(page, '[data-testid="chi-choices"] [data-testid="claim-pass"]');
        if (!pass) found.push('with the 吃 choices open there is no Pass button');
        else {
          found.push(...(await feltSettled(page)).map((f) => `with the 吃 choices open, ${f}`));
          el = pass;
        }
      }
      await tap(page, el);
      await page.waitForTimeout(300);
      continue;
    }
    if ((el = await visible(page, '[data-testid="claim-discard"]'))) {
      await decision();
      await tap(page, el);
      discards++;
      await onDiscard(discards);
      await page.waitForTimeout(300);
      continue;
    }
    if (await visible(page, '[data-testid="hand-discard"]')) {
      await page.waitForTimeout(250);
      await decision();
      if (!sheetChecked) {
        const r = await sheetSeat(page, discards >= 6);
        if (r !== null) {
          sheetChecked = true;
          found.push(...(await discardsSheetCheck(page, r, sheetShot)));
        }
      }
      // The tile the coach rings green (`discard` 'coach': the hand heads for a win, so win prompts come up), else the
      // lowest, right-most one.
      const boxes = await page.$$eval('[data-testid="hand-discard"] [data-testid^="tile-"]', (els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          const coach = [...e.querySelectorAll('div')].some((d) => getComputedStyle(d).borderTopColor === 'rgb(53, 208, 74)');
          return { x: r.x, y: r.y, w: r.width, h: r.height, coach };
        }),
      );
      const hand = boxes.filter((b) => b.w > 0).sort((a, b) => b.y - a.y || b.x - a.x);
      const pick = (discard === 'coach' && hand.find((b) => b.coach)) || hand[0];
      if (pick) await page.mouse.click(pick.x + pick.w / 2, pick.y + pick.h / 2);
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(250);
  }
  if (await visible(page, '[data-testid="result-sheet"]')) {
    await page.waitForTimeout(600);
    found.push(...(await ribbonCheck(page)));
  }
  return { found: tally(found), discards, prompts };
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
  // Going from Home to the table keeps the page's Chinese title (nothing else sets it).
  const title = await page.title();
  if (title !== '麻將狂熱') fails.push(`${where}: the page title is "${title}", not 麻將狂熱`);
  const fit = await tableFit(page);
  fails.push(...fit.bad.map((f) => `${where}: ${f}`));
  // Play on for several of my discards (my pond grows a row, the felt fills): at each of my decisions the coach is on
  // screen with its advice whole (coachCheck).
  const played = await playCoachedHand(page, {
    untilDiscards: 8,
    onDiscard: async (n) => {
      if (n === 6) await page.screenshot({ path: path.join(out, `${tag}-${name}-later.png`) });
    },
  });
  fails.push(...played.found.map((f) => `${where}, in the hand: ${f}`));
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
  // The browser's tab names the app in the reader's language, and the page says which language it is in.
  const head = await page.evaluate(() => ({ title: document.title, lang: document.documentElement.lang }));
  if (head.title !== '麻將狂熱') fails.push(`Home (zh-TW): the page title is "${head.title}", not 麻將狂熱`);
  if (head.lang !== 'zh-Hant-TW') fails.push(`Home (zh-TW): the page's lang is "${head.lang}", not zh-Hant-TW`);
  fails.push(...(await homeFit(page)).map((f) => `Home (zh-TW): ${f}`));
  fails.push(...(await pressTargets(page)).map((f) => `Home (zh-TW): ${f}`));
  fails.push(...(await tapsReach(page)).map((f) => `Home (zh-TW): ${f}`));
  // The wordmark reads the Chinese app name (common.appName), whole and on screen.
  const mark = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div[dir="auto"]')].filter((e) => e.children.length === 0 && e.textContent === '麻將狂熱' && e.getBoundingClientRect().width > 0);
    return els.map((e) => { const r = e.getBoundingClientRect(); return { off: r.left < -1 || r.right > innerWidth + 1 || r.top < -1, cut: e.scrollWidth > e.clientWidth + 1 || r.height > parseFloat(getComputedStyle(e).lineHeight || '0') * 1.6 + 2 }; });
  });
  if (mark.length === 0) fails.push('Home (zh-TW): the wordmark does not read 麻將狂熱');
  else if (mark.some((m) => m.off || m.cut)) fails.push('Home (zh-TW): the 麻將狂熱 wordmark is cut, wrapped or off screen');
  // Every Chinese title heavy, in the system's Chinese face: Home's cards, then Learn's (its cards and lesson titles).
  fails.push(...(await latinChinese(page)).map((f) => `Home (zh-TW): Chinese in a Latin face, thin: ${f}`));
  fails.push(...(await splitWords(page, '[data-testid="home-rules"]')).map((f) => `Home (zh-TW): ${f}`));
  if (await tapSel(page, '[data-testid="open-learn"]', 1200)) {
    await page.screenshot({ path: path.join(out, `${tag}-learn-zh.png`) });
    fails.push(...(await latinChinese(page)).map((f) => `Learn (zh-TW): Chinese in a Latin face, thin: ${f}`));
    // Unit 21's check: 一將四 / 圈 and 底 / 300 on the lesson cards.
    fails.push(...(await splitWords(page, 'body')).map((f) => `Learn (zh-TW): ${f}`));
  } else fails.push('Home (zh-TW): Learn does not open');
  await ctx.close();
  return { size: `${tag} zh-TW`, finished: true, shots: ['home-zh', 'learn-zh'], notes: [], fails, errors };
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
  fails.push(...(await pressTargets(page)).map((f) => `Home (en): ${f}`));
  fails.push(...(await tapsReach(page)).map((f) => `Home (en): ${f}`));
  if ((await page.title()) !== 'Mahjong Mania') fails.push(`Home (en): the page title is "${await page.title()}", not Mahjong Mania`);

  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  let discards = 0;
  const done = new Set();
  // The coach's and the felt's findings at each of my decisions through the whole hand (coachCheck, feltCheck).
  const coach = [];
  const feltFound = [];
  const started = Date.now();
  while (Date.now() - started < 240000) {
    if (await visible(page, 'text=Next hand')) break;
    // The feel: a call-out banner, and the winner's hand face up during the hold before the result sheet.
    if (!done.has('win-hold') && (await visible(page, '[data-testid="win-reveal"]'))) { done.add('win-hold'); await page.waitForTimeout(700); await shot('win-hold'); }
    if (!done.has('callout') && (await visible(page, '[data-testid="call-banner"]'))) { done.add('callout'); await shot('callout'); }
    let el;
    if ((el = await visible(page, '[data-testid="claim-win"]'))) { coach.push(...(await coachSettled(page, true))); feltFound.push(...(await feltSettled(page))); await tap(page, el); await page.waitForTimeout(400); continue; }
    if ((el = await visible(page, 'text="過"'))) {
      coach.push(...(await coachSettled(page, true)));
      feltFound.push(...(await feltSettled(page)));
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
      coach.push(...(await coachSettled(page, true)));
      feltFound.push(...(await feltSettled(page)));
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
        if (!(await openWithin(page, '[data-testid="leave-table"]', '[data-testid="leave-sheet"]', 700))) fails.push('exit icon left without asking');
        await shot('exit-sheet');
        fails.push(...(await dialogKeys(page)).map((f) => `Exit sheet: ${f}`));
        await tapSel(page, '[data-testid="leave-stay"]', 500);
        if (!(await goneWithin(page, '[data-testid="leave-sheet"]')) || !(await visible(page, '[data-testid="leave-table"]'))) fails.push('keep playing did not return to the table');
        if (await staysInert(page, '[data-testid="leave-sheet"]')) fails.push('Exit sheet: the table stays inert after the sheet closed');
        else if (await otherDialogOpen(page, '[data-testid="leave-sheet"]')) notes.push('the hand ended while the exit sheet was open: its result sheet keeps the table inert');
      }
      await page.waitForTimeout(300);
      continue;
    }
    // My discard turn: the first-game tap hint, or (once it has retired) the hand marked for discarding.
    if ((await visible(page, 'text=Tap a tile, tap again to discard')) || (await visible(page, '[data-testid="hand-discard"]'))) {
      coach.push(...(await coachSettled(page, true)));
      feltFound.push(...(await feltSettled(page)));
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
  fails.push(...tally(coach).map((f) => `Table (en), coach: ${f}`));
  fails.push(...tally(feltFound).map((f) => `Table (en), felt: ${f}`));
  const finished = !!(await visible(page, 'text=Next hand'));
  await page.waitForTimeout(600);
  await shot('result');
  if (!finished) notes.push('hand did not finish');

  if (finished) {
    // The result sheet is a modal dialog: named, the table behind it inert, and the keyboard kept on its own buttons.
    fails.push(...(await resultModal(page)).map((f) => `Result sheet: ${f}`));
    // Its controls, the audit pill among them, take a 44 px press, and a tap on one never reaches another (the table
    // behind is inert, so only the sheet's are counted).
    fails.push(...(await pressTargets(page)).map((f) => `Result sheet: ${f}`));
    fails.push(...(await tapsReach(page)).map((f) => `Result sheet: ${f}`));
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
    if (!(await openWithin(page, '[data-testid="start-match"]', '[data-testid="replace-table"]', 900))) fails.push('Start match replaced the saved table without asking');
    else {
      await shot('replace-table');
      fails.push(...(await dialogKeys(page)).map((f) => `Replace-table question: ${f}`));
    }
    await tapSel(page, '[data-testid="confirm-no"]', 700);
    if (!(await goneWithin(page, '[data-testid="replace-table"]')) || !(await visible(page, '[data-testid="resume-card"]'))) fails.push('"Keep my table" did not keep the saved table');
    if (await staysInert(page, '[data-testid="replace-table"]')) fails.push('Replace-table question: Home stays inert after the question closed');
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
    fails.push(...(await pressTargets(page)).map((f) => `Settings: ${f}`));
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
 * Extra-large tiles in landscape: a table at Settings → Display → Tiles: Extra large (and Extra-large text), played
 * through a whole hand, captured five discards in as <size>-table-xl.png. Fails if the hand rail scrolls sideways (a
 * hand tile off the rail), a hand tile is off screen, the hand is no larger than a row sharing the rail with my plate
 * (Extra-large moves the plate above the hand), or the coach fails coachCheck at any of my decisions in the hand.
 */
/**
 * The Extra-large runs' seed (seedContext; the hand follows the coach): the across seat claims three sets and a flower, a
 * line of melds wider than a 1024 px tablet's centre column at Extra-large tiles.
 */
const XL_SEED = 301;

async function runXL(browser, port, [w, h]) {
  const tag = `${w}x${h}`;
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
    localStorage.setItem('mjm.display', JSON.stringify({ tileScale: 1.5, textScale: 1.3 }));
  });
  await seedContext(ctx, XL_SEED);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  // The hand's checks at Extra-large tiles, on the page as it stands.
  let xlTile = 0;
  const xlChecks = [];
  const xlFit = async () => {
    const bad = [];
    if (await page.$('[data-testid="hand-scroll"]')) bad.push('extra-large hand scrolls sideways');
    // Every seat tag still fits at Extra-large tiles (side seats on two lines at most).
    bad.push(...(await tableFit(page)).bad.filter((f) => /seat/.test(f)));
    const off = await page.$$eval('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]', (els) =>
      els.filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1; }).length,
    );
    if (off) bad.push(`${off} extra-large hand tiles off screen`);
    // Extra-large moves my plate and melds above the hand, so the row spans the screen: a hand tile at least as wide
    // as 17 tiles across the footer allow (tableFit.ts fitRowTile), or the height cap where that is smaller.
    xlTile = await page.$$eval('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]', (els) => Math.round(Math.min(...els.map((e) => e.getBoundingClientRect().width))));
    const want = Math.min(Math.floor((h * 0.2) / 1.4), Math.floor((w - 24 - 8 - 10 + 2) / 17) - 2);
    if (!(xlTile >= want)) bad.push(`extra-large hand tiles are ${xlTile} px wide, under the ${want} px a full-width row gives`);
    return bad;
  };
  // A whole hand, with the coach checked at each of my decisions; the shot and the hand checks a few turns in.
  const played = await playCoachedHand(page, {
    discard: 'coach',
    onDiscard: async (n) => {
      if (n !== 5) return;
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(out, `${tag}-table-xl.png`) });
      xlChecks.push(...(await xlFit()));
    },
  });
  const discards = played.discards;
  if (discards < 5) {
    await page.screenshot({ path: path.join(out, `${tag}-table-xl.png`) });
    xlChecks.push(...(await xlFit()));
  }
  fails.push(...xlChecks);
  fails.push(...played.found.map((f) => `Extra-large tiles, coach: ${f}`));
  await ctx.close();
  return { size: `${tag} xl`, seed: SEED_OVERRIDE ?? XL_SEED, finished: true, discards, prompts: played.prompts, shots: ['table-xl'], notes: [`hand tile ${xlTile} px wide`], fails, errors };
}

/**
 * The coach through a whole hand on the smallest phones and at the sizes where it used to vanish: 568x320 in landscape
 * and 320x568 in portrait at Normal tiles in English and at Extra-large tiles and text in Traditional Chinese, and
 * 667x375 at Large tiles and text in English (<size>-coach-<lang>-t<tiles>.png, a few turns in). Fails when coachCheck
 * fails at any of my decisions, or when the coach's sheet (opened from the bar two discards in, <size>-coach-*-sheet.png)
 * has no status, fails dialogKeys, or does not close on Escape.
 */
const COACH_RUNS = [
  // 127: a self-drawn win at the end of the hand, in the 50 px dock.
  [[568, 320], 'en-US', 1, 1, 127],
  [[568, 320], 'zh-TW', 1.5, 1.3, 12],
  [[320, 568], 'en-US', 1, 1, 13],
  [[320, 568], 'zh-TW', 1.5, 1.3, 14],
  [[667, 375], 'en-US', 1.25, 1.15, 15],
  // An 11-inch tablet (the showcase's): the coach's side panel, wider where the centre has room (layout.ts coachReach).
  [[1194, 834], 'zh-TW', 1, 1, 16],
  // A phone in portrait that follows the coach to a win (seed 22): the result ribbon's stars beside its title (ribbonCheck).
  [[390, 844], 'en-US', 1, 1, 22, 'coach'],
];

async function runCoach(browser, port, [[w, h], locale, tileScale, textScale, seed, follow]) {
  const tag = `${w}x${h}`;
  const name = `coach-${locale === 'zh-TW' ? 'zh' : 'en'}-t${tileScale}${follow ? `-${follow}` : ''}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale });
  await ctx.addInitScript(([t, x]) => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
    localStorage.setItem('mjm.display', JSON.stringify({ tileScale: t, textScale: x }));
  }, [tileScale, textScale]);
  await seedContext(ctx, seed);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  const sheet = [];
  const played = await playCoachedHand(page, {
    // Landscape: the hand follows the coach, so win prompts come up in the narrow dock (and where a run asks for it).
    discard: follow ?? (w > h ? 'coach' : 'last'),
    onDiscard: async (n) => {
      if (n === 4) await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
      // A tablet's coach is the full panel, not a bar that opens a sheet ("More" opens it where its text runs over).
      if (n !== 2 || Math.min(w, h) >= 680) return;
      // The coach's sheet, from its bar: everything it says, a dialog that keeps the keyboard and the page as the other
      // sheets do (dialogKeys), closed by Escape with focus back on the bar.
      // The sheet slides in; on a busy machine that can take longer than the usual pause (`openWithin`).
      if (!(await openWithin(page, '[data-testid="coach"]', '[data-testid="coach-sheet"]', 700))) {
        sheet.push('the coach bar did not open its sheet');
        return;
      }
      await page.screenshot({ path: path.join(out, `${tag}-${name}-sheet.png`) });
      if (!(await page.evaluate(() => [...document.querySelectorAll('[data-testid="coach-sheet"] [data-testid="coach-sheet-status"]')].some((e) => e.textContent.trim())))) sheet.push("the coach's sheet has no status");
      sheet.push(...(await dialogKeys(page)).map((f) => `the coach's sheet: ${f}`));
      await page.keyboard.press('Escape');
      // The sheet fades out; on a busy machine that can take longer than a fixed wait, so poll for up to 3 s.
      let open = true;
      for (let t = 0; t < 30 && open; t++) {
        await page.waitForTimeout(100);
        open = !!(await visible(page, '[data-testid="coach-sheet"]'));
      }
      if (open) sheet.push("Escape did not close the coach's sheet");
      if (await staysInert(page, '[data-testid="coach-sheet"]')) sheet.push("the table stays inert after the coach's sheet closed");
    },
  });
  const finished = !!(await visible(page, '[data-testid="result-sheet"]'));
  await ctx.close();
  const where = `Coach (${tag}, ${locale}, tiles ${tileScale}, text ${textScale}, seed ${SEED_OVERRIDE ?? seed})`;
  return { size: `${tag} ${name}`, seed: SEED_OVERRIDE ?? seed, finished, discards: played.discards, prompts: played.prompts, shots: [name, `${name}-sheet`], notes: finished ? [] : ['hand did not finish'], fails: [...sheet, ...played.found].map((f) => `${where}: ${f}`), errors };
}

/**
 * The felt through a whole hand on the phones it is tightest on, at Large and Extra-large tiles and text in English and
 * Traditional Chinese (<size>-felt-<lang>-t<tiles>-x<text>.png, six discards in): feltCheck and coachCheck at each of my
 * decisions. With the main runs (390x844 and 360x740 at Normal), the Chinese table runs and the coach runs at 320x568,
 * they cover every portrait size e2e:screens opens and the three it adds here (360x640, 375x667, 320x568); and the short
 * landscape phones at Extra-large tiles (568x320, 667x375).
 */
const FELT_RUNS = [
  [[390, 844], 'en-US', 1.5, 1.3, 21],
  [[360, 740], 'zh-TW', 1.5, 1.3, 22],
  [[375, 667], 'en-US', 1.5, 1, 23],
  [[360, 640], 'zh-TW', 1.25, 1.3, 24],
  [[360, 640], 'en-US', 1.5, 1.15, 25],
  [[320, 568], 'en-US', 1.5, 1.15, 26],
  [[320, 568], 'zh-TW', 1, 1.3, 27],
  // 146: a win on a discard offered with Pass and a Chow (wider than the 240 px dock in English); 126: Pass, Chow, Pong and
  // Kong at one discard.
  [[568, 320], 'en-US', 1.5, 1.3, 146],
  [[568, 320], 'zh-TW', 1.5, 1.3, 126],
  [[667, 375], 'en-US', 1.5, 1.3, 30],
];

async function runFelt(browser, port, [[w, h], locale, tileScale, textScale, seed]) {
  const tag = `${w}x${h}`;
  const name = `felt-${locale === 'zh-TW' ? 'zh' : 'en'}-t${tileScale}-x${textScale}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale });
  await ctx.addInitScript(([t, x]) => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
    localStorage.setItem('mjm.display', JSON.stringify({ tileScale: t, textScale: x }));
  }, [tileScale, textScale]);
  await seedContext(ctx, seed);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  const played = await playCoachedHand(page, {
    onDiscard: async (n) => {
      if (n === 6) await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
    },
    sheetShot: path.join(out, `${tag}-${name}-discards.png`),
    // Landscape: the hand follows the coach, so win prompts come up in the narrow dock; portrait never wins, so the
    // ponds fill up.
    discard: w > h ? 'coach' : 'last',
  });
  const finished = !!(await visible(page, '[data-testid="result-sheet"]'));
  // The result sheet on these phones: its buttons' labels whole.
  if (finished) await page.waitForTimeout(600);
  const labels = finished ? await sheetLabels(page) : [];
  await ctx.close();
  const where = `Felt (${tag}, ${locale}, tiles ${tileScale}, text ${textScale}, seed ${SEED_OVERRIDE ?? seed})`;
  return { size: `${tag} ${name}`, seed: SEED_OVERRIDE ?? seed, finished, discards: played.discards, prompts: played.prompts, shots: [name], notes: finished ? [] : ['hand did not finish'], fails: [...played.found, ...labels].map((f) => `${where}: ${f}`), errors };
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
// Home in Traditional Chinese, whose labels are the widest on its narrowest cards: the five viewports and 320x568 too.
const HOME_ZH_SIZES = PREVIEW_SIZES;

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
      await tapSel(page, '[data-testid="preview-play-th.dumpling"]', 0);
      // The bubble pops in a moment after the tap; on a busy machine that moment can pass 300 ms, so wait up to 3 s for it.
      const played = await page.waitForSelector('[data-testid="preview-emote-bubble"]', { state: 'visible', timeout: 3000 }).then(() => true, () => false);
      if (!played) fails.push(`${where}: tapping an emote does not play it`);
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
    if (!(await goneWithin(page, '[data-testid="look-preview"]'))) fails.push(`${where}: ${id}'s preview does not close`);
    const focusedOn = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    if (!(await until(page, async () => (await focusedOn()) === `preview-${id}`))) fails.push(`${where}: focus went to ${(await focusedOn()) || 'nothing'}, not back to ${id}'s card, when the preview closed`);
    if (await staysInert(page, '[data-testid="look-preview"]')) fails.push(`${where}: the Shop stays inert after ${id}'s preview closed`);
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
  // SCREENS_ONLY=preview,xl (say) runs only those groups: table, xl, table-zh, table-zh-xl, home-zh, boards, preview, coach, felt.
  const only = (process.env.SCREENS_ONLY || '').split(',').filter(Boolean);
  const want = (group) => only.length === 0 || only.includes(group);
  const results = await Promise.all([
    ...(want('table') ? SIZES : []).map((s) => run(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]}`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('xl') ? XL : []).map((s) => runXL(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]} xl`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('table-zh') ? SIZES : []).map((s) => runTableZh(browser, port, s, false).catch((e) => ({ size: `${s[0]}x${s[1]} table-zh`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('table-zh-xl') ? SIZES : []).map((s) => runTableZh(browser, port, s, true).catch((e) => ({ size: `${s[0]}x${s[1]} table-zh-xl`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('home-zh') ? HOME_ZH_SIZES : []).map((s) => runHomeZh(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]} zh-TW`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('boards') ? SIZES : []).map((s) => runBoards(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]} leaderboards`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('preview') ? PREVIEW_SIZES : []).flatMap((s) => [false, true].map((zh) => runPreview(browser, port, s, zh).catch((e) => ({ size: `${s[0]}x${s[1]} preview${zh ? '-zh' : ''}`, finished: false, notes: [e.message], errors: [] })))),
    ...(want('coach') ? COACH_RUNS.filter(([[w, h]]) => !wanted.length || wanted.includes(`${w}x${h}`)) : []).map((c) => runCoach(browser, port, c).catch((e) => ({ size: `${c[0][0]}x${c[0][1]} coach`, finished: false, notes: [e.message], errors: [] }))),
    ...(want('felt') ? FELT_RUNS.filter(([[w, h]]) => !wanted.length || wanted.includes(`${w}x${h}`)) : []).map((c) => runFelt(browser, port, c).catch((e) => ({ size: `${c[0][0]}x${c[0][1]} felt`, finished: false, notes: [e.message], errors: [] }))),
  ]);
  for (const r of results) console.log(JSON.stringify(r));
  await browser.close();
  server.close();
  process.exit(results.every((r) => r.finished && r.errors.length === 0 && (r.fails || []).length === 0) ? 0 : 1);
})().catch((e) => {
  console.error('SCREENS FAIL', e.message);
  process.exit(1);
});

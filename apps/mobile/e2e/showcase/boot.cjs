/**
 * The showcase player's first launch against the local game server (docs/SCREENSHOTS.md): the app signs up its own
 * guest account, and the page's storage (the session and the device id) is saved for the capture runs, which serve the
 * export on the same origin.
 * Usage: node boot.cjs <webdir> <state.json> <name> <avatar> <en-US|zh-TW>
 */
const { PORT, serve, launch, tapSel } = require('./lib.cjs');

const [webdir, stateFile, name, avatar, locale] = process.argv.slice(2);

(async () => {
  const server = await serve(webdir);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, locale });
  await ctx.addInitScript(
    ([name, avatar]) => {
      if (localStorage.getItem('mjm.showcaseBooted')) return;
      localStorage.setItem('mjm.showcaseBooted', '1');
      localStorage.setItem('mjm.profile', JSON.stringify({ userId: '', name, avatar }));
      // An adult who has answered the privacy question (no analytics), so no gate or question covers a screen.
      localStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1991, at: Date.now(), synced: false }));
      localStorage.setItem('mjm.privacy', JSON.stringify({ v: 1, given: true, minor: false, analytics: false, crash: false, asked: true }));
      localStorage.setItem('mjm.tapHint', '3');
    },
    [name, avatar],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 60000 });
  await page.waitForTimeout(3000);
  // The leaderboards need the account, so the app has signed up by the time they show.
  await tapSel(page, '[data-testid="open-learn"]', 2000);
  await tapSel(page, '[data-testid="open-leaderboards"]', 2000);
  let id = '';
  for (let i = 0; i < 30 && !id; i++) {
    id = await page.evaluate(() => JSON.parse(localStorage.getItem('mjm.profile') || '{}').userId || '');
    if (!id) await page.waitForTimeout(1000);
  }
  if (!id) throw new Error('the app did not sign up: is the game server running on localhost:8787?');
  await page.waitForTimeout(2000);
  await ctx.storageState({ path: stateFile });
  console.log('account', id, 'saved to', stateFile);
  await browser.close();
  server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

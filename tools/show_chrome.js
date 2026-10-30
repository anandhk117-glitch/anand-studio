// Brings Studio Chrome on screen (for signing in), on the Vibes tab if one is open.
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  let page = ctx.pages().find((p) => /vibes\.ai/.test(p.url())) || ctx.pages()[0] || await ctx.newPage();
  if (!/vibes\.ai/.test(page.url())) await page.goto('https://vibes.ai/').catch(() => {});
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 30, width: 1400, height: 900 } });
  await page.bringToFront();
  console.log('Studio Chrome is on screen:', page.url());
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });

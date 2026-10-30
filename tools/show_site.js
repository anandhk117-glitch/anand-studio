// Opens a site in Studio Chrome ON SCREEN so Anand can sign in: node tools/show_site.js https://www.dola.com/
const { chromium } = require('playwright-core');
(async () => {
  const url = process.argv[2];
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message.split('\n')[0]));
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 30, width: 1400, height: 900 } });
  await page.bringToFront();
  await page.waitForTimeout(6000);
  console.log('ON SCREEN:', page.url());
  console.log((await page.evaluate(() => document.body?.innerText || '')).slice(0, 600));
  await page.screenshot({ path: 'data/_show_site.jpg', type: 'jpeg', quality: 55 });
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });

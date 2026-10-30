// The free browser agent: makes pictures and clips on websites (Google Flow, Meta Vibes, Grok …)
// in its own normal Chrome window ("Studio Chrome") where Anand signed in once.
//
// How it works — "learn once, replay":
//   1. A saved recipe (data/browser_recipes/<site>.json) is replayed step by step.
//   2. If a step can't be found (the site changed), Gemini (free AI Studio key) looks at a
//      screenshot plus the list of buttons/boxes and picks the next action. Steps that worked
//      are saved as the new recipe, so the next run needs no Gemini.
//   3. Safety stops in code (not up to the model): login pages, "verify you're human" checks,
//      buy/upgrade/credits screens → stop at once, tell Anand, never continue past them.
//      Never types into password boxes, never clicks buy/upgrade/subscribe/delete buttons.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const llm = require('./llm');

const SITES_FILE = path.join(store.P.root, 'config', 'browser_sites.json');
const RECIPES = path.join(store.P.root, 'data', 'browser_recipes');
const PROFILE = path.join(store.P.root, 'data', 'chrome-studio');
const USAGE = path.join(store.P.root, 'data', 'browser_usage.json');
const PORT = 9333;

const sites = () => store.readJSON(SITES_FILE, { sites: {}, order: { images: [], videos: [] } });

class Blocked extends Error { constructor(kind, msg) { super(msg); this.kind = kind; this.blocked = true; } }

// ---------------- Chrome ----------------
function chromePath() {
  const s = store.getSettings();
  const c = [s.chrome_path, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'), '/usr/bin/google-chrome', '/opt/pw-browsers/chromium'].filter(Boolean);
  return c.find((x) => { try { return fs.existsSync(x); } catch { return false; } });
}
async function cdpUp() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
// A normal Chrome window (not launched by an automation tool), with its own profile, so sign-in works normally.
async function ensureChrome(url) {
  if (await cdpUp()) return;
  const exe = chromePath();
  if (!exe) throw new Error('Chrome is not installed (or set Settings → chrome_path).');
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=http://127.0.0.1', ...(store.getSettings().studio_chrome_hidden !== false ? ['--window-position=-2600,0', '--window-size=1600,1000'] : ['--start-maximized']), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', ...(process.env.STUDIO_CHROME_HEADLESS ? ['--headless=new', '--no-sandbox'] : []), url || 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) { if (await cdpUp()) return; await sleep(500); }
  throw new Error('Studio Chrome did not start.');
}
let _browser = null;
async function connect() {
  await ensureChrome();
  if (_browser && _browser.isConnected()) return _browser;
  const { chromium } = require('playwright-core');
  _browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  return _browser;
}
// Studio Chrome works out of sight: its window sits off-screen and new tabs open in the background,
// so it never pops up or takes the keyboard while Anand is using the PC. "Open Studio Chrome" brings it back.
let shownAt = 0;
async function placeWindow(page, show) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: show ? { left: 60, top: 40, width: 1500, height: 950 } : { left: -2600, top: 0, width: 1600, height: 1000 } });
    await cdp.detach().catch(() => {});
  } catch {}
}
// Pages a job is working in right now. Every other tab is closed when a new job starts (saves RAM;
// only the tab waiting for Anand's sign-in on the Live page is kept).
const busyPages = new Set();
async function tidyTabs(ctx, keep) {
  for (const p of ctx.pages()) {
    if (p === keep || busyPages.has(p) || (live.page === p && live.info.needs) || /#keep/.test(p.url())) continue; // '#keep' = a tab Anand or a test is using
    await p.close().catch(() => {});
  }
}
async function newPage() {
  const b = await connect();
  const ctx = b.contexts()[0] || await b.newContext();
  let page = null;
  try {
    const bs = await b.newBrowserCDPSession();
    const wait = ctx.waitForEvent('page', { timeout: 10000 });
    await bs.send('Target.createTarget', { url: 'about:blank', background: true });
    page = await wait;
    await bs.detach().catch(() => {});
  } catch { page = await ctx.newPage(); }
  page.setDefaultTimeout(20000);
  busyPages.add(page); page.on('close', () => busyPages.delete(page));
  await tidyTabs(ctx, page).catch(() => {});
  if (store.getSettings().studio_chrome_hidden !== false && Date.now() - shownAt > 20 * 60000) await placeWindow(page, false);
  return page;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens Studio Chrome on the sign-in pages so Anand can sign in once.
async function openForSignIn() {
  const list = Object.values(sites().sites).filter((x) => x.enabled !== false).map((x) => x.signin || x.url);
  await ensureChrome(list[0]);
  const b = await connect();
  const ctx = b.contexts()[0];
  for (const u of list.slice(1)) { const p = await ctx.newPage(); p.goto(u).catch(() => {}); }
  shownAt = Date.now(); // stays visible for 20 minutes so Anand can sign in, then goes back out of sight
  const first = ctx.pages()[0]; if (first) await placeWindow(first, true);
  return list;
}

// ---------------- safety ----------------
const RX = {
  login: /accounts\.google\.com\/(v3\/)?signin|facebook\.com\/login|auth\.meta\.com|meta\.ai\/login|x\.com\/i\/flow\/login|accounts\.x\.ai\/sign/i,
  captcha: /verify (that )?you('| a)re (a )?human|i'm not a robot|are you a robot|unusual traffic from your|confirm it's you|complete the security check/i,
  money: /buy (more )?credits|add credits|get more credits|out of credits|not enough credits|insufficient credits|(you've|you have) (reached|hit|used) (your|the|all) (daily |free )?(limit|credits|generations)|add a payment method/i,
  badClick: /buy|purchase|upgrade|subscribe|payment|billing|add credits|get credits|delete|remove account|sign out|log ?out/i,
};
async function safety(page) {
  const url = page.url();
  if (RX.login.test(url)) throw new Blocked('login', `asks to sign in (${new URL(url).host}) — open Studio Chrome and sign in once`);
  // A visible challenge box (not the invisible reCAPTCHA badge many sites carry).
  const challenge = await page.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => {
    const r = f.getBoundingClientRect();
    return r.width > 120 && r.height > 60 && /recaptcha\/api2\/(anchor|bframe)|hcaptcha|challenges\.cloudflare|arkoselabs|funcaptcha/i.test(f.src) && !/size=invisible/.test(f.src);
  })).catch(() => false);
  if (challenge) throw new Blocked('captcha', 'shows a "verify you are human" check — tick it once in Studio Chrome');
  const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 20000)).catch(() => '');
  if (RX.captcha.test(text)) throw new Blocked('captcha', 'shows a "verify you are human" check — tick it once in Studio Chrome');
  if (RX.money.test(text)) throw new Blocked('credits', `says "${text.match(RX.money)[0]}" — the free credits look used up for today`);
}

// A slow page can look signed-out for a moment: check, and if it looks signed out, wait, reload and check once more.
async function signedIn(page, site) {
  try { return await signedInOnce(page, site); }
  catch (e) {
    if (!e.blocked || e.kind !== 'login') throw e;
    await sleep(6000); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(6000);
    return signedInOnce(page, site);
  }
}
async function signedInOnce(page, site) {
  // Some sites (Qwen) show an empty skeleton while loading, and only load on a tab in front: wait for the real page first.
  if (site.front) await page.bringToFront().catch(() => {});
  if (site.ready) await page.locator(site.ready).first().waitFor({ timeout: 30000 }).catch(() => {});
  const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 6000)).catch(() => '');
  if (/not available in (your|this) (country|region)|isn.t available in (your|this) (country|region)/i.test(body) || /region-restricted/i.test(page.url())) throw new Error(`${site.name} says it is not available in your country right now — using the next tool`);
  const so = site.signed_out || {};
  if (so.url && new RegExp(so.url, 'i').test(page.url())) throw new Blocked('login', `${site.name}: not signed in — open Studio Chrome (Settings → Browser agent) and sign in once`);
  if (so.text) {
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 6000)).catch(() => '');
    if (new RegExp(so.text, 'i').test(text)) throw new Blocked('login', `${site.name}: not signed in — open Studio Chrome (Settings → Browser agent) and sign in once`);
  }
}

// ---------------- what's on the page ----------------
async function elements(page) {
  return page.evaluate(() => {
    const sel = 'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="textbox"], [role="checkbox"], [role="radio"], label';
    const out = [];
    let i = 0;
    // Picture/video tiles are often plain clickable boxes: add the visible ones too.
    const tiles = [...document.querySelectorAll('img, video')].filter((m) => { const r = m.getBoundingClientRect(); return r.width >= 60 && r.height >= 60 && r.bottom > 0 && r.top < innerHeight; })
      .map((m) => m.closest('button, a, [role="button"], [tabindex]') || m);
    // A pop-up window is open: only its own buttons count (the page behind it can't be clicked anyway).
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].filter((d) => { const r = d.getBoundingClientRect(); return r.width > 50 && r.height > 50 && getComputedStyle(d).visibility !== 'hidden'; });
    const top = dialogs.length ? dialogs[dialogs.length - 1] : null;
    const inScope = (el) => !top || top.contains(el);
    const all = [...new Set([...document.querySelectorAll(sel), ...tiles])].filter(inScope);
    for (const el of all) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const fileInput = el.tagName === 'INPUT' && el.type === 'file';
      if (!fileInput && (r.width < 4 || r.height < 4 || st.visibility === 'hidden' || st.display === 'none' || r.bottom < 0 || r.top > innerHeight)) continue;
      const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const media = el.matches('img,video') ? el : el.querySelector?.('img,video');
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('data-tooltip') || (media ? `[${media.tagName === 'VIDEO' ? 'video' : 'picture'} tile ${Math.round(r.width)}x${Math.round(r.height)}]` : '');
      el.setAttribute('data-studio-i', String(i));
      out.push({ i, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', text, label: label.slice(0, 60),
        file: fileInput, password: el.type === 'password', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      i++;
      if (out.length >= 160) break;
    }
    return out;
  });
}
const hintOf = (e) => ({ tag: e.tag, text: e.text, label: e.label, type: e.type, file: e.file });
function findByHint(els, h) {
  if (!h) return null;
  const score = (e) => (e.tag === h.tag ? 1 : 0) + (h.label && e.label === h.label ? 4 : 0) + (h.text && e.text === h.text ? 3 : 0) + (h.type && e.type === h.type ? 1 : 0) + (h.file && e.file ? 3 : 0);
  const best = els.map((e) => [score(e), e]).sort((a, b) => b[0] - a[0])[0];
  return best && best[0] >= 4 ? best[1] : null;
}
async function shot(page) {
  const b = await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' });
  return b.toString('base64');
}

// Click that also works when a pop-up layer sits on top or the element is still animating.
async function hardClick(page, loc, el) {
  try { await loc.click({ timeout: 5000 }); return; } catch {}
  try { await loc.click({ timeout: 3000, force: true }); return; } catch {}
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const b = await loc.boundingBox().catch(() => null);
  if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  else if (el) await page.mouse.click(el.x, el.y);
  else throw new Error('could not click');
}

// ---------------- one action ----------------
async function act(page, a, els, vars) {
  const el = a.index != null ? els.find((e) => e.i === a.index) : null;
  const loc = el ? page.locator(`[data-studio-i="${el.i}"]`).first() : null;
  if (el && el.password) throw new Blocked('login', 'reached a password box — Anand must sign in himself');
  if (el && (a.action === 'click') && RX.badClick.test(`${el.text} ${el.label}`)) throw new Error(`refused to click "${el.text || el.label}" (buy/upgrade/delete)`);
  const val = (v) => String(v || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  switch (a.action) {
    case 'goto': await page.goto(val(a.url), { waitUntil: 'domcontentloaded', timeout: 45000 }); await sleep(2500); return;
    case 'click': {
      if (!loc) throw new Error('nothing to click');
      await hardClick(page, loc, el);
      await sleep(1200); return;
    }
    case 'type': {
      if (!loc) throw new Error('no box to type in');
      const text = val(a.text);
      await loc.click({ timeout: 10000 });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await page.keyboard.insertText(text);
      await sleep(600); return;
    }
    case 'press': await page.keyboard.press(a.key || 'Enter'); await sleep(1000); return;
    case 'upload': {
      const files = (vars.files || []).filter((f) => fs.existsSync(f));
      if (!files.length) return;
      if (el && el.file) { await loc.setInputFiles(files); await sleep(3000); return; }
      // Many sites keep a hidden file box: use it directly when there is one.
      const hidden = async () => {
        const fi = page.locator('input[type=file]');
        const n = await fi.count();
        if (!n) return false;
        await fi.nth(n - 1).setInputFiles(files);
        await sleep(3000);
        return true;
      };
      if (!loc) { if (await hidden()) return; throw new Error('no upload button'); }
      // Click the button: it may open the file picker, or a small menu with an "Upload" item.
      const chooser = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
      await hardClick(page, loc, el);
      let fc = await chooser;
      if (!fc) {
        const item = page.getByText(/^\s*(upload( media| an? image| images?| files?| from (your )?(computer|device))?|from (your )?computer|add (image|media|file)s?|browse( files)?)\s*$/i).last();
        if (await item.count()) {
          const ch2 = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
          await item.click({ timeout: 5000 }).catch(() => {});
          fc = await ch2;
        }
      }
      if (fc) { await fc.setFiles(files); await sleep(3000); return; }
      if (await hidden()) return;
      throw new Error('could not open the upload box');
    }
    case 'scroll': await page.mouse.wheel(0, a.dy || 600); await sleep(700); return;
    case 'wait': await sleep(Math.min(120, Math.max(1, a.seconds || 5)) * 1000); return;
    default: throw new Error('unknown action ' + a.action);
  }
}

// ---------------- media on the page ----------------
// Sites re-sign media addresses (?Expires=…) every few minutes: compare by address without the query.
const keyOf = (u) => String(u).split('?')[0];
async function mediaList(page, kind) {
  return page.evaluate((kind) => {
    if (kind === 'videos') return [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src || v.querySelector('source')?.src).filter(Boolean);
    return [...document.querySelectorAll('img')].filter((im) => im.naturalWidth >= 500 && im.naturalHeight >= 280).map((im) => im.currentSrc || im.src);
  }, kind);
}
async function grab(page, url) {
  const typeOf = (mime) => (/png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : /jpe?g/.test(mime) ? 'jpg' : /mp4/.test(mime) ? 'mp4' : /webm/.test(mime) ? 'webm' : mime.startsWith('video') ? 'mp4' : 'png');
  // 1) Normal web address: download with the browser's own signed-in session (no page CORS limits).
  if (/^https?:/i.test(url)) {
    try {
      const r = await page.context().request.get(url, { timeout: 120000 });
      if (r.ok()) {
        const buf = await r.body();
        const mime = (r.headers()['content-type'] || '').split(';')[0];
        if (buf.length > 5000) return { buffer: buf, ext: typeOf(mime || 'image/png'), mime: mime || 'image/png' };
      }
    } catch {}
  }
  // 2a) blob: links (Vheer): read the bytes inside the page in chunks (the way that works for big videos).
  if (/^blob:/i.test(url)) {
    try {
      const b64 = await page.evaluate(async (u) => {
        const r = await fetch(u); const a = new Uint8Array(await r.arrayBuffer());
        let s = ''; const CH = 0x8000;
        for (let i = 0; i < a.length; i += CH) s += String.fromCharCode.apply(null, a.subarray(i, i + CH));
        return { t: r.headers.get('content-type') || 'video/mp4', d: btoa(s) };
      }, url);
      if (b64?.d?.length > 5000) return { buffer: Buffer.from(b64.d, 'base64'), ext: typeOf(b64.t), mime: b64.t };
    } catch {}
  }
  // 2) blob:/data: or a protected address: read it inside the page.
  try {
    const b64 = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      const blob = await r.blob();
      return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    }, url);
    const m = String(b64).match(/^data:([^;]+);base64,(.*)$/);
    if (m && m[2].length > 5000) return { buffer: Buffer.from(m[2], 'base64'), ext: typeOf(m[1]), mime: m[1] };
  } catch {}
  // 3) Pictures only: draw it onto a canvas at full size.
  try {
    const b64 = await page.evaluate(async (u) => {
      const im = [...document.images].find((x) => (x.currentSrc || x.src) === u);
      if (!im) return null;
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      return c.toDataURL('image/png');
    }, url);
    if (b64) return { buffer: Buffer.from(b64.split(',')[1], 'base64'), ext: 'png', mime: 'image/png' };
  } catch {}
  // 4) Last resort for pictures: a screenshot of the picture element.
  const el = page.locator(`img[src="${url.replace(/"/g, '\\"')}"]`).first();
  if (await el.count()) return { buffer: await el.screenshot({ type: 'png' }), ext: 'png', mime: 'image/png' };
  throw new Error('could not read the result');
}

// ---------------- fixed scripts for sites whose steps are known ----------------
const SCRIPTS = {
  // Vibes: Create new → Start, end frame → Add start frame → Upload (file) → Upload (confirm) → pick tile → Add to video → prompt → send.
  async vibes(page, vars, onStep, name) {
    const file = (vars.files || [])[0];
    const byText = (re, root = page) => root.locator('button, [role="button"], a').filter({ hasText: re }).first();
    const say = (m) => onStep(`${name}: ${m}`);
    const create = byText(/^\s*Create new\s*$/i);
    if (await create.count()) { say('new project'); await hardClick(page, create); await page.waitForURL(/\/projects\//, { timeout: 30000 }).catch(() => {}); await sleep(4000); }
    const box = page.locator('textarea, [contenteditable="true"]').filter({ hasNot: page.locator('[type=hidden]') }).first();
    await box.waitFor({ timeout: 30000 });
    say('start frame');
    await hardClick(page, byText(/Start,\s*end frame/i)); await sleep(1200);
    const addStart = page.getByText(/^\s*(Add )?start frame\s*$/i).first();
    if (await addStart.count()) { await hardClick(page, addStart); await sleep(2000); }
    const pick = page.locator('[role="dialog"]').filter({ hasText: /Select start frame/i }).first();
    await pick.waitFor({ timeout: 15000 });
    say('upload the scene picture');
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
    await hardClick(page, pick.locator('button').filter({ hasText: /^\s*Upload\s*$/i }).first());
    const fc = await chooser;
    if (fc) await fc.setFiles([file]);
    else { const fi = page.locator('input[type=file]'); await fi.nth((await fi.count()) - 1).setInputFiles([file]); }
    await sleep(2500);
    const upDlg = page.locator('[role="dialog"]').filter({ hasText: /Upload images/i }).last();
    if (await upDlg.count()) { await hardClick(page, upDlg.locator('button').filter({ hasText: /^\s*Upload\s*$/i }).last()); await sleep(5000); }
    say('select it as the start frame');
    const tiles = pick.locator('img');
    for (let k = 0; k < 20 && !(await tiles.count()); k++) await sleep(1000);
    if (!(await tiles.count())) throw new Error('the uploaded picture did not appear');
    await hardClick(page, tiles.last()); await sleep(1500);
    const add = pick.locator('button').filter({ hasText: /Add to video/i }).first();
    if (await add.isDisabled().catch(() => true)) { await hardClick(page, tiles.first()); await sleep(1500); }
    await hardClick(page, add); await sleep(2500);
    // 720p: Vibes makes 480p unless "Advanced" says 720p (no extra cost).
    try {
      const adv = byText(/^\s*Advanced\s*$/i);
      if (await adv.count()) {
        await hardClick(page, adv); await sleep(1200);
        const hd = page.getByText(/^\s*720p\s*$/i).first();
        if (await hd.count()) { await hd.click({ timeout: 4000 }).catch(() => {}); say('720p'); }
        await hardClick(page, adv).catch(() => {}); await sleep(800); // close the panel the same way it opened
      }
    } catch {}
    say('write the motion prompt');
    // Type, then check the prompt is really in the box (a popover can steal the focus); never send an empty prompt.
    const key = String(vars.prompt).slice(0, 25);
    let typed = false;
    for (let k = 0; k < 3 && !typed; k++) {
      await hardClick(page, box); await sleep(500);
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.insertText(vars.prompt);
      await sleep(800);
      typed = ((await box.innerText().catch(() => '')) || (await box.inputValue().catch(() => ''))).includes(key);
    }
    if (!typed) throw new Error('the prompt did not go into the box — not sending');
    say('generate');
    const send = page.locator('button[type="submit"], button[aria-label*="send" i], button[aria-label*="generate" i], button[aria-label*="submit" i]').last();
    if (await send.count()) await hardClick(page, send); else await page.keyboard.press('Enter');
    await sleep(3000);
  },
  // Meta AI pictures: attach the reference files (character sheets, costume line-up, set) → type the prompt → check it is in the box → send.
  // Fixed steps, because the "eyes" kept sending the pictures with Meta's default text ("Tell me about this image").
  async meta(page, vars, onStep, name) {
    const say = (m) => onStep(`${name}: ${m}`);
    await page.bringToFront().catch(() => {});
    const box = page.locator('div[contenteditable="true"]:visible, textarea:visible').first();
    await box.waitFor({ timeout: 30000 });
    const files = (vars.files || []).filter((f) => fs.existsSync(f));
    if (files.length) {
      say(`attach ${files.length} reference picture(s)`);
      const imgsBefore = await page.locator('img').count();
      let fi = page.locator('input[type=file]');
      if (!(await fi.count())) {
        const chooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
        await hardClick(page, page.locator('button[aria-label*="media" i], button[aria-label*="attach" i], button[aria-label*="add" i]').first());
        const fc = await chooser; if (fc) await fc.setFiles(files); else throw new Error('no attach button found');
      } else await fi.nth((await fi.count()) - 1).setInputFiles(files);
      for (let k = 0; k < 30 && (await page.locator('img').count()) < imgsBefore + files.length; k++) await sleep(1000);
      await sleep(2500);
      if (await page.locator('[role=dialog]:visible').count()) await page.keyboard.press('Escape').catch(() => {}); // close a media picker if one opened
    }
    say('type the prompt');
    const key = String(vars.prompt).slice(0, 25);
    let typed = false;
    for (let k = 0; k < 3 && !typed; k++) {
      await hardClick(page, box); await sleep(400);
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.insertText(vars.prompt);
      await sleep(800);
      typed = ((await box.innerText().catch(() => '')) || (await box.inputValue().catch(() => ''))).includes(key);
    }
    if (!typed) throw new Error('the prompt did not go into the box — not sending');
    say('send');
    const send = page.locator('button[aria-label*="send" i]:visible, button[type="submit"]:visible').last();
    if (await send.count()) await hardClick(page, send); else await page.keyboard.press('Enter');
    await sleep(3000);
  },
  // Dola (ByteDance, Seedance 2.0 Fast): AI Creation → Video → 16:9 → 5s → + picture → prompt → Enter. About 4 free clips a day.
  async dola(page, vars, onStep, name) {
    const say = (m) => onStep(`${name}: ${m}`);
    await page.bringToFront().catch(() => {}); await sleep(6000);
    const btn = (re) => page.locator('button:visible').filter({ hasText: re }).first();
    await btn(/^\s*Video\s*$/).click({ timeout: 20000 }); await sleep(1500);
    await btn(/^\s*Ratio/).click().catch(() => {}); await sleep(900);
    const r169 = page.getByText(/^\s*16:9\s*$/).first(); if (await r169.count()) await r169.click(); else await page.keyboard.press('Escape');
    await sleep(700);
    await btn(/^\s*\d+s\s*$/).click().catch(() => {}); await sleep(900);
    const want = vars.long ? '10s' : '5s';
    const s5 = page.getByText(new RegExp('^\\s*' + want + '\\s*$')).first(); if (await s5.count()) await s5.click(); else { await page.keyboard.press('Escape'); if (vars.long) throw new Error('10 s is not offered here'); }
    if (vars.long) say('10 s clip (two scenes in one)');
    await sleep(700);
    say('upload the scene picture');
    const ib = await btn(/^\s*Image\s*$/).boundingBox();
    let attached = false;
    for (const dx of [50, 60, 40, 70]) {
      const fc = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
      await page.mouse.click(ib.x - dx, ib.y + ib.height / 2);
      const ch = await fc; if (ch) { await ch.setFiles([(vars.files || [])[0]]); attached = true; break; }
      await page.keyboard.press('Escape'); await sleep(600);
    }
    if (!attached) throw new Error('could not open the picture upload');
    for (let k = 0; k < 30; k++) { await sleep(1500); const busy = await page.evaluate(() => /\b\d{1,2}%/.test(document.querySelector('textarea')?.closest('div')?.parentElement?.innerText || '')).catch(() => false); if (!busy && k > 2) break; }
    say('write the motion prompt');
    const box = page.locator('textarea:visible, [contenteditable="true"]:visible').first();
    await box.click(); await page.keyboard.insertText(String(vars.prompt).replace(/\b\d+\s*:\s*\d+\b/g, ''));
    await sleep(800);
    say('generate');
    await page.keyboard.press('Enter');
    await sleep(5000);
  },
  // Vheer: free picture-to-video (0 credits, no sign-in): picture → prompt → Generate. About 40 s per clip.
  async vheer(page, vars, onStep, name) {
    const say = (m) => onStep(`${name}: ${m}`);
    await page.bringToFront().catch(() => {}); await sleep(5000);
    say('upload the scene picture');
    const fi = page.locator('input[type=file]');
    for (let k = 0; k < 10 && !(await fi.count()); k++) await sleep(1000);
    await fi.first().setInputFiles([(vars.files || [])[0]]);
    await sleep(6000);
    say('write the motion prompt');
    await page.locator('textarea:visible').first().fill(vars.prompt);
    await sleep(800);
    const gen = page.locator('button:visible').filter({ hasText: /Generate/ }).first();
    const label = (await gen.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!/\|\s*0\b/.test(label)) throw new Blocked('cap', `${name}: Generate now costs credits ("${label}") — skipping`);
    say('generate');
    await gen.click();
    await sleep(3000);
  },
  // Qwen Chat: Select Mode → Create Video → upload the picture → describe → Send (learned from its one good run).
  async qwen(page, vars, onStep, name) {
    const say = (m) => onStep(`${name}: ${m}`);
    await page.locator('textarea').first().waitFor({ timeout: 40000 });
    await page.bringToFront().catch(() => {}); await sleep(2000); // Qwen's menus only open on a tab that is in front
    say('video mode');
    await page.locator('[aria-label="Select Mode"]').first().click({ timeout: 10000 });
    const cv = page.getByRole('menuitem', { name: /Create Video/i }).first();
    await cv.waitFor({ timeout: 10000 }); await cv.click(); await sleep(1500);
    const gotIt = page.getByRole('button', { name: /^\s*Got it\s*$/i }).first();
    if (await gotIt.isVisible().catch(() => false)) { await gotIt.click(); await sleep(800); }
    say('upload the scene picture');
    const box = page.locator('textarea').first();
    const tb = await box.boundingBox();
    const fc = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.mouse.click(tb.x + 25, tb.y - 50); // the picture slot above the text box
    (await fc).setFiles([(vars.files || [])[0]]);
    // Wait (max 90 s) until the picture's thumbnail replaces the spinner in the slot; never send without the picture.
    let up = false;
    for (let k = 0; k < 45 && !up; k++) {
      await sleep(2000);
      if (k % 5 === 4) await page.bringToFront().catch(() => {});
      up = await page.evaluate(({ x, y }) => [...document.images].some((im) => { const r = im.getBoundingClientRect(); return im.complete && im.naturalWidth > 0 && r.width > 30 && r.width < 160 && r.bottom <= y + 5 && r.bottom > y - 160 && r.left < x + 200; }), { x: tb.x, y: tb.y }).catch(() => false);
    }
    if (!up) throw new Error('the picture did not finish uploading');
    await sleep(1500);
    say('write the motion prompt');
    await box.click();
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.insertText(vars.prompt);
    await sleep(800);
    say('generate');
    await page.locator('button[type="submit"], [aria-label="Send"]').last().click({ timeout: 10000 });
    await sleep(3000);
  },
};

// Video sites with strict filters (Vibes) want a short, plain prompt: the action only, no brand names or body/negative words.
function shortMotion(text, simple) {
  let t = String(text || '').split(/Smooth, natural|Real speed|Keep every face/i)[0];
  t = t.replace(/^[^:]{3,40}:\s*/, ''); // drop the "label:" part
  t = t.replace(/pixar[- ]?(quality|style)?/gi, '').replace(/\b(limbs?|bodies|body|hips?|chest|warp\w*|rubber\w*|jitter\w*|sliding|floating)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  // Words that make strict video filters refuse cartoon scenes with children: say the same thing more plainly.
  t = t.replace(/\bbounc\w*\s*/gi, 'bobbing ').replace(/jump(ing|s)? up and down/gi, 'hop on the spot to the beat').replace(/\bjump(ing|s)?\b/gi, 'hop')
    .replace(/\bspin(s|ning)?( round| around)?\b/gi, 'sway').replace(/\bhug(s|ging)?\b/gi, 'stand close to').replace(/tilting their heads back/gi, 'smiling')
    .replace(/\b(kids|children|little ones)\b/gi, 'cartoon friends').replace(/\b(kid|child)\b/gi, 'cartoon friend').replace(/\s{2,}/g, ' ');
  // One simple action that works in a 5-second clip: drop moves that make characters walk off, circle or turn their backs.
  t = t.split(/(?<=[.;])\s+/).map((c) => c.replace(/\b(form(s|ing)? a (small |big )?circle( and)?|in a circle|walk(s|ing)?( \w+){0,4}|run(s|ning)?( \w+){0,4}|chase\w*( \w+){0,4}|turn(s|ing)? (round|around|back)|spin\w*|round and round|go(es)? around)\b/gi, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim()).filter((c) => c.length > 3 && !/^smooth\.?$/i.test(c)).join(' ').replace(/\b(form(s|ing)? a (small |big )?circle and)\s*/gi, '');
  if (simple) t = t.split(/[.;]/)[0];
  return `${t}${/[.!]$/.test(t) ? '' : '.'} Everyone stays in the same place facing the camera; nobody turns around or walks away. Lively, smooth, clearly visible movement all through the clip at real speed — no slow motion, no frozen moments. Steady camera.`;
}

// ---------------- the agent loop ----------------
const SYSTEM = `You operate a web page for a kids' YouTube studio. You see a screenshot and a numbered list of the page's buttons and boxes.
Reply with ONE next action as JSON:
{"action":"click|type|upload|press|scroll|wait|done|blocked","index":<number from the list or null>,"text":"<for type>","key":"<for press>","seconds":<for wait>,"reason":"<short>"}
Rules: use only the listed indexes. "type" puts text into a box (use the exact text you are given, with its {placeholders}). "upload" attaches the reference files: choose the upload/attach/+ button or a file input. "wait" while something is generating. "done" only when the requested result is fully visible on the page.
Answer "blocked" if you see a sign-in page, a human-verification check, a payment/upgrade/credits screen or an error you cannot fix.
Never click anything that buys, upgrades, subscribes, deletes or signs out. Never type passwords. Free features only.
Good habits: close harmless pop-ups (tips, cookie notices with "Decline"/"Only necessary", "replace file?" → OK) and carry on. Upload the picture ONCE. Press the send/create button ONCE — after that only "wait" until the result shows (generation takes 1–5 minutes). If a click changed nothing, do not repeat it: pick a different element, scroll, or wait. Follow the LESSONS from earlier runs.`;

// ---------------- lessons per site (how the agents get better) ----------------
// Every failure and every success is written down; the last few are shown to the eyes next time.
const LESSONS = path.join(store.P.root, 'data', 'site_lessons');
function lessons(id) { return store.readJSON(path.join(LESSONS, id + '.json'), []); }
function learn(id, ok, text) {
  fs.mkdirSync(LESSONS, { recursive: true });
  const L = lessons(id); const t = String(text).replace(/\s*\[screenshot:[^\]]*\]/g, '').slice(0, 300);
  if (L.length && L[L.length - 1].text === t) { L[L.length - 1].n = (L[L.length - 1].n || 1) + 1; L[L.length - 1].t = new Date().toISOString(); }
  else L.push({ t: new Date().toISOString(), ok, text: t });
  store.writeJSON(path.join(LESSONS, id + '.json'), L.slice(-30));
}
function lessonText(id) {
  const L = lessons(id).slice(-8);
  return L.length ? '\n\nLESSONS from earlier runs on this site (avoid the mistakes, repeat what worked):\n' + L.map((l) => `- ${l.ok ? 'WORKED' : 'FAILED'}${l.n > 1 ? ' ×' + l.n : ''}: ${l.text}`).join('\n') : '';
}

// A dropped connection (net::ERR_…) is a blip, not a failure: wait a minute and try once more.
async function runTask(siteId, job, onStep = () => {}) {
  try { return await runTaskOnce(siteId, job, onStep); }
  catch (e) {
    if (e.blocked || e.refused || !/net::ERR_|ERR_CONNECTION|ECONNRESET|Timeout .*goto/i.test(e.message)) throw e;
    onStep(`${sites().sites[siteId]?.name || siteId}: connection dropped — trying again in a minute`);
    await new Promise((r) => setTimeout(r, 60000));
    return runTaskOnce(siteId, job, onStep);
  }
}
async function runTaskOnce(siteId, job, onStep = () => {}) {
  const site = sites().sites[siteId];
  if (!site) throw new Error('Unknown site ' + siteId);
  checkCap(siteId, site);
  const vars = { prompt: (site.prompt_template || '{prompt}').replace('{prompt}', site.short_prompt ? shortMotion(job.prompt, job.simple) : job.prompt) + ((job.files || []).length > 1 ? ` (Reference pictures attached: ${(job.files || []).map((f) => path.basename(f).replace(/^char_/, '').replace(/\.[^.]+$/, '')).join(', ')} — use every one.)` : ''), files: job.files || [], file_names: (job.files || []).map((f) => path.basename(f)).join(', '), long: !!job.long, length: job.long ? '10 s' : '5 s' };
  // A picture with no reference files (e.g. an empty set): chat sites answer a bare prompt with text, so ask for an image plainly.
  if (job.kind === 'images' && !(job.files || []).length && !/^(create|generate|imagine)\b/i.test(vars.prompt)) vars.prompt = 'Create an image: ' + vars.prompt;
  // Runs without files (empty sets) learn their own recipe, so they never overwrite the one that uploads the character sheets.
  const recipeFile = path.join(RECIPES, siteId + ((job.files || []).length || job.kind !== 'images' ? '' : '_nofiles') + '.json');
  const recipe = store.readJSON(recipeFile, null);
  const page = await newPage();
  setLive(page, { site: site.name, kind: job.kind });
  let keepOpen = false;
  const used = [];
  // One project per song/video on sites that have projects (Flow): remember its address and go straight back to it.
  const projFile = path.join(store.P.root, 'data', 'browser_projects.json');
  const known = job.project_key && site.project_url_rx ? store.readJSON(projFile, {})[siteId]?.[job.project_key] : null;
  try {
    await page.goto(known || site.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => { if (NET_DOWN.test(e.message)) throw new Blocked('offline', `${site.name}: the PC has no internet right now — nothing was sent; trying again later`); throw e; });
    await sleep(3500);
    await online(page, site);
    await safety(page);
    await signedIn(page, site);
    let step = 0;
    const inProject = !!known && new RegExp(site.project_url_rx, 'i').test(page.url());
    const replay = inProject ? [] : (recipe?.steps || []).slice();
    let learned = false;
    const goal = (inProject && site.goal_in_project ? site.goal_in_project : site.goal || '').replace(/\{(\w+)\}/g, (_, k) => (k === 'files' ? vars.file_names || '(none)' : vars[k] ?? ''));
    const goalFull = (job.files || []).length ? goal : goal + ' There are NO files to attach this time: skip any attach/upload step, just type the prompt and send it.';
    let before = new Set();
    let misses = 0; let useEyes = false;
    if (site.script && SCRIPTS[site.script]) {
      for (const m of await mediaList(page, job.kind)) { before.add(m); before.add(keyOf(m)); }
      try {
        await SCRIPTS[site.script](page, vars, onStep, site.name);
        await safety(page);
        // Sample/demo videos that the site shows after switching modes are not ours: everything on the page right after sending is "old".
        for (const m of await mediaList(page, job.kind)) { before.add(m); before.add(keyOf(m)); }
        step = (site.max_steps || 30) + 1; // fixed steps done: skip the eyes, go straight to waiting for the result
      } catch (e) {
        if (e.blocked) throw e;
        onStep(`${site.name}: fixed steps stopped (${e.message.split('\n')[0].slice(0, 80)}) — the eyes take over`);
        await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(3000);
        before = new Set();
      }
    }
    // Known harmless pop-ups (e.g. PixVerse "replace file?") are answered directly, without asking the eyes.
    const autoConfirm = async () => {
      for (const c of site.auto_confirm || []) {
        const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (!new RegExp(c.text, 'i').test(body)) continue;
        const b = page.getByRole('button', { name: new RegExp('^\\s*' + c.button + '\\s*$', 'i') }).last();
        if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); onStep(`${site.name}: pressed "${c.button}" on "${c.text}"`); await sleep(1500); }
      }
    };
    while (step++ < (site.max_steps || 30)) {
      await safety(page);
      await autoConfirm();
      const nUp = used.filter((u) => u.action === 'upload').length;
      const last3 = used.slice(-3);
      if (last3.length === 3 && last3.every((u) => u.action === 'click' && JSON.stringify(u.hint) === JSON.stringify(last3[0].hint))) throw new Error(`${site.name}: clicked the same button 3 times with no change — stopped (button: "${last3[0].hint?.text || last3[0].hint?.label || '?'}")`);
      if (nUp > Math.max(1, (vars.files || []).length) + 2) throw new Error(`${site.name}: kept uploading the picture in a loop — using the next site`);
      // Until the prompt has been SENT (a click/Enter after typing), everything on the page counts as "old"
      // — including the reference pictures we just uploaded.
      const typedAt = used.findIndex((u) => u.action === 'type');
      const sent = typedAt >= 0 && used.slice(typedAt + 1).some((u) => u.action === 'click' || u.action === 'press');
      if (!sent) for (const m of await mediaList(page, job.kind)) { before.add(m); before.add(keyOf(m)); }
      const els = await elements(page);
      let a = null;
      if (replay.length) {
        const r = replay.shift();
        if (r.action === 'done') a = r;
        else if (['wait', 'press', 'scroll', 'goto'].includes(r.action)) a = { ...r };
        else { const e = findByHint(els, r.hint); if (e) a = { ...r, index: e.i }; else replay.length = 0; }
      }
      if (!a) {
        learned = true;
        const list = els.map((e) => `${e.i}: <${e.tag}${e.type ? ' ' + e.type : ''}>${e.file ? ' [file input]' : ''} "${e.text}"${e.label ? ` (${e.label})` : ''}`).join('\n');
        const done = used.map((u) => `${u.action}${u.hint ? ` "${u.hint.text || u.hint.label}"` : ''}`).join(' → ') || 'nothing yet';
        const nRefs = (vars.files || []).length;
        const added = used.filter((u) => u.action === 'click' && /add to prompt|add to video|use as ingredient/i.test(`${u.hint?.text || ''} ${u.hint?.label || ''}`)).length;
        const upN = used.filter((u) => u.action === 'upload').length;
        const upNote = upN ? `\nThe picture is ALREADY uploaded (${upN}×) — even if you cannot see it clearly, do NOT upload again. Next: ${used.some((u) => u.action === 'type') ? 'press the send / create button ONCE, then wait' : 'type the prompt into the prompt box'}.` : '';
        const progress = upNote + (nRefs ? `\nReference pictures added as ingredients so far: ${Math.min(added, nRefs)} of ${nRefs}.${added >= nRefs ? ' ALL references are added — do NOT add any more; type the prompt and send it now.' : ''}` : '');
        if (nRefs && added >= nRefs + 2) throw new Error('kept adding reference pictures in a loop — will retry');
        const ask = `GOAL: ${goalFull}${progress}${lessonText(siteId)}\n\nDone so far: ${done}\n\nThe text to type is exactly: {prompt}\nReference files to upload: ${vars.file_names || 'none'}\n\nPAGE ELEMENTS:\n${list}`;
        // First the free local model on this PC reads the button list (no daily limit);
        // after a miss, or if it can't decide, Gemini looks at the screenshot.
        // Gemini's eyes first (fast and sharp); the local model on this PC only steps in when Gemini's free limit is used up.
        if (!a) {
          try { const { json } = await llm.vision(ask, [{ mime: 'image/jpeg', data: await shot(page) }], { system: SYSTEM }); a = json; }
          catch (e) { if (!(e.quota || /429|quota/i.test(e.message)) || !store.getSettings().ollama_text_model) throw e; useEyes = false; }
        }
        if (!a && store.getSettings().ollama_text_model) {
          try {
            const r = await llm.local([{ role: 'system', content: SYSTEM }, { role: 'user', content: ask + '\n(You cannot see the screenshot; decide from the element list. If unsure, answer {"action":"wait","seconds":2,"reason":"unsure"}.)' }], { timeoutMs: 180000 });
            const j = llm.extractJSON(r.text);
            const okIdx = j && (j.index == null || els.some((e) => e.i === j.index));
            if (j && ['click', 'type', 'upload', 'press', 'scroll', 'wait'].includes(j.action) && (j.action !== 'click' && j.action !== 'upload' || j.index != null) && okIdx && !(j.action === 'wait' && /unsure/i.test(j.reason || '')) && !['blocked', 'done'].includes(j.action)) { a = j; a._local = true; } // "blocked"/"done" are confirmed by the eyes
          } catch {}
        }
        if (!a) throw Object.assign(new Error('Vision failed: free Gemini limit used up and the local model could not decide'), { quota: true });
        useEyes = false;
      }
      const upDone = used.filter((u) => u.action === 'upload').length;
      if (a.action === 'upload' && upDone >= Math.max(1, (vars.files || []).length)) { a = { action: 'wait', seconds: 3, reason: 'picture already uploaded — not uploading again' }; }
      if (a.action === 'type') a.text = '{prompt}'; // the only thing ever typed is the prompt
      onStep(`${site.name}: ${a.action}${a.reason ? ' — ' + a.reason : ''}`);
      if (a.action === 'blocked') throw new Blocked('site', a.reason || 'the site stopped the job');
      if (a.action === 'done') break;
      if (a.action === 'type' && !/\{prompt\}/.test(a.text || '') && a.text === job.prompt) a.text = '{prompt}';
      const el = a.index != null ? els.find((e) => e.i === a.index) : null;
      if ((a.action === 'click' || a.action === 'press') && used.some((u) => u.action === 'type')) {
        await sleep(1500); // let uploaded thumbnails finish appearing, then remember them as old
        for (const m of await mediaList(page, job.kind)) { before.add(m); before.add(keyOf(m)); }
      }
      try { await act(page, a, els, vars); misses = 0; }
      catch (err) {
        if (err.blocked || /refused to click/.test(err.message)) throw err;
        misses += 1;
        useEyes = true; // a guess missed: next step with the screenshot
        onStep(`${site.name}: ${a.action} missed (${err.message.split('\n')[0].slice(0, 80)}) — looking again`);
        if (misses >= 4) throw err;
        replay.length = 0; // the saved steps no longer fit this page: let the eyes decide
        await sleep(1500);
        continue;
      }
      used.push({ action: a.action, ...(el ? { hint: hintOf(el) } : {}), ...(a.text ? { text: a.text } : {}), ...(a.key ? { key: a.key } : {}), ...(a.seconds ? { seconds: a.seconds } : {}), ...(a.url ? { url: a.url } : {}) });
    }
    await online(page, site); // an offline error page is not a send — never count it
    markSent(siteId);
    const refusals = (t) => (site.refusal_text ? (String(t).match(new RegExp(site.refusal_text, 'gi')) || []).length : 0);
    const refusedBefore = refusals(await page.evaluate(() => document.body?.innerText || '').catch(() => ''));
    // Wait for the result to appear (generation can take a while).
    const deadline = Date.now() + (site.result_timeout_s || 240) * 1000;
    let fresh = [];
    let preGrabbed = null;
    while (Date.now() < deadline) {
      await safety(page);
      await autoConfirm();
      const bodyNow = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/insufficient credits|not enough credits|out of credits|credits? (are|have been) used up|upgrade to continue/i.test(bodyNow) || (site.cap_text && new RegExp(site.cap_text, 'i').test(bodyNow))) throw new Blocked('cap', `${site.name}: says the free credits are used up for now`);
      if (RATE.test(bodyNow)) { coolDown(siteId); const hrs = (store.readJSON(USAGE, {}).cool_hits?.[siteId] || []).length; throw new Error(`${site.name}: says too many requests — resting it for ${hrs <= 1 ? '15 minutes' : hrs === 2 ? '1 hour' : hrs === 3 ? '4 hours' : '8 hours'} and using the next site`); }
      if (site.refusal_text && refusals(bodyNow) > refusedBefore) { // only a NEW refusal counts — old failed items on the page don't
        const err = new Error(`${site.name}: the site refused this prompt`); err.refused = true; throw err;
      }
      const isNew = (u) => !before.has(u) && !before.has(keyOf(u)) && (!site.result_src || new RegExp(site.result_src).test(u));
      fresh = (await mediaList(page, job.kind)).filter(isNew);
      if (!fresh.length && site.result_click && new RegExp(site.result_click, 'i').test(bodyNow)) {
        // The site shows the finished clip as a picture with a play button; the real video appears only after a click.
        await page.bringToFront().catch(() => {});
        await page.evaluate(() => { const big = [...document.images].filter((im) => im.getBoundingClientRect().width > 300); const last = big[big.length - 1]; if (last) last.click(); }).catch(() => {});
        await sleep(3500);
        fresh = (await mediaList(page, job.kind)).filter(isNew);
      }
      if (fresh.length >= 1) {
        if (job.kind === 'videos' && (site.takes || 4) > 1) {
          // Sites like Vibes make several takes per send and they finish one by one: wait (max 2 min) until no new take appears for 20 s.
          let n = fresh.length, still = Date.now(); const until = Date.now() + 120000;
          while (Date.now() < until && n < 4 && Date.now() - still < 20000) { await sleep(4000); const f2 = (await mediaList(page, job.kind)).filter(isNew); if (f2.length > n) { n = f2.length; still = Date.now(); } }
          await sleep(4000);
        } else await sleep(job.kind === 'videos' ? 300 : 2500); // one-take sites: save at once (their blob link can expire)
        fresh = (await mediaList(page, job.kind)).filter(isNew);
        if (job.kind === 'videos' && site.takes === 1) {
          // Save it right now; if that "video" can't be read (a loading animation), ignore it and keep waiting for the real one.
          const got = await grab(page, fresh[fresh.length - 1]).catch(() => null);
          if (got && got.buffer.length > 100000) { preGrabbed = [got]; break; }
          for (const u of fresh) { before.add(u); before.add(keyOf(u)); }
          fresh = []; await sleep(4000); continue;
        }
        break;
      }
      onStep(`${site.name}: waiting for the ${job.kind === 'videos' ? 'clip' : 'picture'}…`);
      await sleep(5000);
    }
    if (!fresh.length && !preGrabbed) throw new Error(`${site.name}: no new ${job.kind === 'videos' ? 'clip' : 'picture'} appeared`);
    const results = preGrabbed ? [...preGrabbed] : [];
    if (preGrabbed) fresh = [];
    let grabErr = '';
    const q = require('./quality');
    for (const u of fresh.slice(0, job.kind === 'videos' ? (site.takes || 4) : 6)) {
      try {
        let r; try { r = await grab(page, u); } catch (e1) { if (job.kind !== 'videos') throw e1; await sleep(8000); r = await grab(page, u); }
        if (job.kind !== 'videos' && await q.isOneOf(r.buffer, job.files || [])) { grabErr = 'only the uploaded reference pictures were found'; continue; } // an uploaded sheet, not the result
        results.push(r);
        if (job.kind !== 'videos' && results.length >= 4) break;
      } catch (e) { grabErr = `${e.message} (${String(u).slice(0, 80)})`; }
    }
    if (!results.length) throw new Error(`${site.name}: could not save the result — ${grabErr}`);
    if (job.project_key && site.project_url_rx && !inProject && new RegExp(site.project_url_rx, 'i').test(page.url())) {
      const all = store.readJSON(projFile, {}); all[siteId] = { ...(all[siteId] || {}), [job.project_key]: page.url() }; store.writeJSON(projFile, all);
    }
    const messy = used.length > 14 || used.some((u, i) => i > 0 && u.action === 'click' && JSON.stringify(u.hint) === JSON.stringify(used[i - 1].hint));
    if (!inProject && (learned || !recipe) && !messy) { fs.mkdirSync(RECIPES, { recursive: true }); store.writeJSON(recipeFile, { site: siteId, learned: new Date().toISOString(), steps: [...used, { action: 'done' }] }); }
    countUse(siteId);
    learn(siteId, true, `steps ${used.map((u) => u.action + (u.hint ? ` "${(u.hint.text || u.hint.label || '').slice(0, 30)}"` : '')).join(' > ') || '(fixed script)'}`);
    return { results, site: siteId };
  } catch (e) {
    try {
      const dir = path.join(store.P.root, 'data', 'browser_debug');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${siteId}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
      await page.screenshot({ path: f, type: 'jpeg', quality: 60 });
      const files = fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => a.t - b.t);
      for (const old of files.slice(0, -60)) fs.rmSync(path.join(dir, old.n), { force: true }); // keep the newest 60, oldest go first
      e.message += ` [screenshot: data/browser_debug/${path.basename(f)}] [steps: ${used.map((u) => u.action).join('>')}]`;
    } catch {}
    try { learn(siteId, false, `${e.message.split(' [steps')[0]} | steps ${used.map((u) => u.action + (u.hint ? ` "${(u.hint.text || u.hint.label || '').slice(0, 30)}"` : '')).join(' > ')}`); } catch {}
    if (e.blocked && /login|captcha/.test(e.kind || '')) { keepOpen = true; setLive(page, { site: site.name, needs: e.kind === 'captcha' ? 'a human check' : 'sign-in', url: site.signin || site.url }); }
    throw e;
  } finally {
    busyPages.delete(page);
    if (!keepOpen) {
      // Never close the last tab: Chrome would quit. Leave it as an empty page instead.
      if (page.context().pages().length <= 1) await page.goto('about:blank').catch(() => {});
      else await page.close().catch(() => {});
      if (live.page === page) live.page = null;
    }
    await sleep((site.gap_s || 60) * 1000 * 0.25); // short breather; the main pacing is between jobs
  }
}

// ---------------- pacing / daily caps ----------------
const today = () => new Date().toISOString().slice(0, 10);
function checkCap(id, site) {
  const u = store.readJSON(USAGE, {});
  const rest = u.cooldown?.[id] ? Date.parse(u.cooldown[id]) : 0;
  if (rest > Date.now()) throw new Error(`${site.name}: resting until ${new Date(rest).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} (it said "too many requests") — using the next site`);
  const hr = (u.sent?.[id] || []).filter((t) => Date.parse(t) > Date.now() - 3600e3);
  if (site.hourly_cap && hr.length >= site.hourly_cap) {
    const free = new Date(Date.parse(hr[0]) + 3600e3);
    throw new Error(`${site.name}: ${hr.length} clips this hour — pausing it until ${free.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} so it doesn't say "too many requests" — using the next site`);
  }
  const sentToday = ((u.sends_day || {})[today()] || {})[id] || 0;
  if (site.daily_send_cap && sentToday >= site.daily_send_cap) throw new Blocked('cap', `${site.name}: today's ${site.daily_send_cap} sends are used (that is about ${site.daily_send_cap * 4} takes) — back tomorrow`);
  // A site with a "send gap" waits that long after the last SEND before the next one (controlled pace, never a burst).
  if (site.send_gap_min && u.last_send?.[id]) {
    const free = Date.parse(u.last_send[id]) + site.send_gap_min * 60000;
    if (free > Date.now() + 120000) throw new Error(`${site.name}: next send at ${new Date(free).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} (controlled pace) — using the next site meanwhile`);
    if (free > Date.now()) return free - Date.now();
  }
  const d = u[today()] || {};
  if (site.daily_cap && (d[id] || 0) >= site.daily_cap) throw new Blocked('cap', `${site.name}: today's limit of ${site.daily_cap} reached (set in config/browser_sites.json)`);
  const last = u.last?.[id] ? Date.parse(u.last[id]) : 0;
  const wait = (site.gap_s || 60) * 1000 - (Date.now() - last);
  return wait > 0 ? wait : 0;
}
// A site that says "too many requests" is left alone for a few hours; the next site in the list is used meanwhile.
function coolDown(id, hours) {
  const u = store.readJSON(USAGE, {});
  // "Rate limit — wait a minute" is short: rest 15 min first, 1 h if it happens again soon, 3 h on the third time in 6 h.
  const hits = [...(u.cool_hits?.[id] || []).filter((t) => Date.parse(t) > Date.now() - 24 * 3600e3), new Date().toISOString()];
  u.cool_hits = { ...(u.cool_hits || {}), [id]: hits };
  if (hours == null) hours = hits.length <= 1 ? 0.25 : hits.length === 2 ? 1 : hits.length === 3 ? 4 : 8; // daily allowance used up → long rests
  u.cooldown = { ...(u.cooldown || {}), [id]: new Date(Date.now() + hours * 3600e3).toISOString() };
  store.writeJSON(USAGE, u);
}
// No internet (router/Wi-Fi dropped): stop at once without counting a send, so the day's free sends are not wasted.
const NET_DOWN = /ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|CONNECTION_(RESET|REFUSED|TIMED_OUT|CLOSED))|DNS_PROBE/i;
async function online(page, site) {
  const url = page.url();
  const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000)).catch(() => '');
  if (/^chrome-error:/.test(url) || NET_DOWN.test(body) || /No internet|There is no Internet connection/i.test(body)) throw new Blocked('offline', `${site.name}: the PC has no internet right now — nothing was sent; trying again later`);
}
const RATE = /too many requests|rate.?limit|please wait a moment and try again|you.ve reached the limit|try again (later|tomorrow)|daily (limit|quota) (reached|exceeded)/i;
function countUse(id) {
  const u = store.readJSON(USAGE, {});
  const t = today();
  u[t] = { ...(u[t] || {}), [id]: ((u[t] || {})[id] || 0) + 1 };
  u.last = { ...(u.last || {}), [id]: new Date().toISOString() };
  for (const k of Object.keys(u)) if (/^\d{4}-/.test(k) && k < new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)) delete u[k];
  store.writeJSON(USAGE, u);
}
// Every generation actually sent (also the ones that fail later) counts for the hourly pacing.
function markSent(id) {
  const u = store.readJSON(USAGE, {});
  u.sends_day = { ...(u.sends_day || {}), [today()]: { ...((u.sends_day || {})[today()] || {}), [id]: (((u.sends_day || {})[today()] || {})[id] || 0) + 1 } };
  for (const k of Object.keys(u.sends_day)) if (k < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete u.sends_day[k];
  u.last_send = { ...(u.last_send || {}), [id]: new Date().toISOString() };
  u.sent = { ...(u.sent || {}), [id]: [...(u.sent?.[id] || []).filter((t) => Date.parse(t) > Date.now() - 3600e3), new Date().toISOString()] };
  store.writeJSON(USAGE, u);
}
async function pace(id) {
  const site = sites().sites[id];
  const w = checkCap(id, site);
  if (w) await sleep(w);
}

// ---------------- picture checker ----------------
async function checkImage(img, refs, rules, prompt) {
  const imgs = [{ mime: img.mime || 'image/png', data: img.buffer.toString('base64') }];
  for (const r of refs.slice(0, 4)) imgs.push({ mime: 'image/jpeg', data: fs.readFileSync(r).toString('base64') });
  const names = refs.map((r) => path.basename(r).replace(/^char_/, '').replace(/\.[^.]+$/, ''));
  const { json } = await llm.vision(`Image 1 is a new scene for a kids' cartoon. ${refs.length ? `Images 2-${refs.length + 1} are the character sheets for: ${names.join(', ')}.` : ''}
The scene was asked for as: ${prompt}
Channel rules: ${rules}
Check: right characters with the same look as their sheets, correct number of characters, no extra or duplicated characters, no text/labels/watermark-like captions, nothing scary or unsafe, kids fully clothed, nobody chubby, 16:9 framing works.
Reply JSON: {"ok":true|false,"score":0-10,"problems":["short", ...]}`, imgs, { temperature: 0 });
  return { ok: !!json.ok && (json.score ?? 7) >= 6, score: json.score, problems: json.problems || [] };
}

// ---------------- Studio entry points ----------------
async function makeImage(p, sc, refs, onStep, opts = {}) {
  // opts.plain: an empty set / location picture — no wardrobe, no costume line-up, nobody in it.
  const lock = opts.plain ? { text: ' EMPTY PLACE: no people, no characters, no animals at all.', wardrobe: '', animals: '', expected: [], sheet: false, place: true } : { ...require('./quality').lockFor(p, sc), sheet: !!opts.sheet };
  let rules = '';
  try { rules = fs.readFileSync(path.join(store.P.memory, p.channel, 'rules.md'), 'utf8').slice(0, 2500); } catch {}
  const order = (sites().order.images || []).filter((id) => sites().sites[id]?.enabled !== false);
  const errs = [];
  const cast = (store.getChannel(p.channel)?.cast || []).filter((c) => refs.some((r) => path.basename(r).toLowerCase().includes(String(c.name).toLowerCase())));
  const looks = cast.length ? ` Character looks (must match): ${cast.map((c) => `${c.name} — ${c.look}`).join('; ')}.` : '';
  const tries = refs.length >= 3 ? 3 : 2; // group shots get one more try
  let lastProblems = [];
  for (const id of order) {
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        await pace(id);
        const fix = attempt && lastProblems.length ? ` FIX THESE from the last try: ${lastProblems.join('; ')}.` : '';
        const { results } = await runTask(id, { kind: 'images', prompt: sc.image_prompt + looks + lock.text + fix, files: refs, project_key: p.id }, onStep);
        let best = null;
        for (const r of results) {
          const c = await require('./quality').checkImage(r, refs, p.channel, sc.image_prompt, lock).catch(async (e1) => { if (e1.quota) throw e1; await new Promise((r) => setTimeout(r, 20000)); return require('./quality').checkImage(r, refs, p.channel, sc.image_prompt, lock).catch((e2) => { if (e2.quota) throw e2; return { ok: false, score: 0, problems: ['the picture checker could not run — not accepted unchecked'] }; }); });
          try { // keep every candidate with the checker's verdict, for review
            const dir = path.join(store.P.root, 'data', 'browser_debug'); fs.mkdirSync(dir, { recursive: true });
            const base = `${p.id}-scene${sc.n}-${id}-${Date.now()}-${c.ok ? 'OK' : 'REJECT'}-${c.score ?? 'x'}`;
            fs.writeFileSync(path.join(dir, `${base}.${r.ext}`), r.buffer);
            fs.writeFileSync(path.join(dir, `${base}.txt`), (c.problems || []).join('\n'));
          } catch {}
          onStep(`${sites().sites[id].name}: picture check ${c.score ?? '?'}/10${c.problems?.length ? ' — ' + c.problems.slice(0, 2).join('; ') : ''}`);
          if (!best || (c.score || 0) > (best.c.score || 0)) best = { r, c };
          if (c.ok && c.score >= 8) break;
        }
        if (best && best.c.ok) return { ...best.r, site: id, check: best.c };
        lastProblems = (best?.c.problems || []).slice(0, 3);
        errs.push(`${id}: picture failed the check (${(best?.c.problems || []).slice(0, 2).join('; ')})`);
      } catch (e) {
        if (e.quota || /Vision failed:.*(429|quota)/i.test(e.message)) { const q = new Error('free Gemini checker limit used up for today — resumes after 12:30 PM IST'); q.quota = true; throw q; }
        errs.push(`${id}: ${e.message}`);
        onStep(`${sites().sites[id]?.name || id}: try ${attempt + 1} failed — ${e.message.slice(0, 220)}`);
        if (e.blocked) break;
      }
    }
  }
  const err = new Error(errs.join(' | ') || 'No browser sites are switched on.');
  err.blocked = errs.some((x) => /sign in|verify|credits|limit/i.test(x));
  throw err;
}

async function makeClip(p, sc, imagePath, onStep, opts = {}) {
  // opts.long: one 10-second clip that covers two scenes of a continuous shot — only on sites that can make 10 s (long_ok).
  const order = (sites().order.videos || []).filter((id) => sites().sites[id]?.enabled !== false && (!opts.long || sites().sites[id]?.long_ok));
  const errs = [];
  for (const id of order) {
    try {
      await pace(id);
      let res;
      try { res = await runTask(id, { kind: 'videos', prompt: sc.motion_prompt || sc.vision || 'gentle natural movement', files: [imagePath], long: !!opts.long }, onStep); }
      catch (e) {
        if (!e.refused || opts.long) throw e;
        onStep(`${sites().sites[id].name}: prompt refused — trying a plainer prompt`);
        await pace(id);
        res = await runTask(id, { kind: 'videos', prompt: 'The cartoon characters smile, nod and sway gently to the music', files: [imagePath], simple: true }, onStep);
      }
      return { ...res.results[0], takes: res.results, site: id };
    } catch (e) { errs.push(`${id}: ${e.message}`); }
  }
  const err = new Error(errs.join(' | ') || 'No browser video sites are switched on.');
  err.blocked = errs.some((x) => /sign in|verify|credits|limit/i.test(x));
  throw err;
}

async function status() {
  const up = await cdpUp();
  const s = sites();
  const u = store.readJSON(USAGE, {});
  return {
    chrome: up, profile: PROFILE, chrome_found: !!chromePath(),
    sites: Object.entries(s.sites).map(([id, x]) => ({ id, name: x.name, enabled: x.enabled !== false, kind: x.kind, used_today: (u[today()] || {})[id] || 0, daily_cap: x.daily_cap || null, learned: fs.existsSync(path.join(RECIPES, id + '.json')) })),
    order: s.order,
  };
}

// ---------------- live view (watch + sign in from the phone) ----------------
// The Studio website shows this page's screen; taps and typing on the phone are passed to it.
const live = { page: null, info: {}, at: 0 };
function setLive(page, info) { live.page = page; live.info = info || {}; live.at = Date.now(); }
async function livePage() {
  if (live.page && !live.page.isClosed()) return live.page;
  if (!(await cdpUp())) return null;
  const b = await connect();
  const pages = (b.contexts()[0]?.pages() || []).filter((p) => !/^about:blank|^chrome/.test(p.url()));
  return pages[pages.length - 1] || null;
}
async function liveShot() {
  const page = await livePage();
  if (!page) return null;
  const cdp = await page.context().newCDPSession(page);
  try {
    const shot = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 }), sleep(8000).then(() => null)]);
    if (shot?.data) return Buffer.from(shot.data, 'base64');
    await page.bringToFront().catch(() => {});
    return await page.screenshot({ type: 'jpeg', quality: 55, timeout: 10000 });
  } finally { cdp.detach().catch(() => {}); }
}
async function liveAct(a) {
  const page = await livePage();
  if (!page) throw new Error('Nothing is open in Studio Chrome right now.');
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  if (a.type === 'click') await page.mouse.click(Math.round(a.x * vp.w), Math.round(a.y * vp.h));
  else if (a.type === 'type') await page.keyboard.type(String(a.text || '').slice(0, 500), { delay: 30 });
  else if (a.type === 'key') { if (!/^(Enter|Tab|Backspace|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(a.key)) throw new Error('key not allowed'); await page.keyboard.press(a.key); }
  else if (a.type === 'scroll') await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, +a.dy || 0)));
  else if (a.type === 'back') await page.goBack().catch(() => {});
  else if (a.type === 'reload') await page.reload().catch(() => {});
  else throw new Error('unknown action');
  live.at = Date.now();
  return { ok: true };
}
// Opens a site's sign-in page and makes it the live page (for signing in from the phone).
async function liveOpen(siteId) {
  const site = sites().sites[siteId];
  if (!site) throw new Error('Unknown site');
  const page = await newPage();
  await page.goto(site.signin || site.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  setLive(page, { site: site.name, needs: 'sign-in', manual: true });
  return { site: site.name };
}
async function liveClose() {
  if (live.page && live.info.manual) await live.page.close().catch(() => {});
  live.page = null; live.info = {};
  return { ok: true };
}
const liveInfo = () => ({ ...live.info, active: !!(live.page && !live.page.isClosed()), url: live.page && !live.page.isClosed() ? live.page.url() : null, sites: Object.entries(sites().sites).filter(([, x]) => x.enabled !== false).map(([id, x]) => ({ id, name: x.name })) });

module.exports = { ensureChrome, openForSignIn, runTask, makeImage, makeClip, checkImage, status, Blocked, liveShot, liveAct, liveOpen, liveClose, liveInfo };

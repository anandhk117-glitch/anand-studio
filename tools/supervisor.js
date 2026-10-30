// Keeps FreeLLMAPI and the Studio running. Started hidden at Windows login (see tools/autostart.ps1).
// If either one stops, it is started again after a short wait. Logs go to data/logs/.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'data', 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const settings = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8')); } catch { return {}; } })();
const FREELLM = settings.freellmapi_dir || 'C:\\putaniloka-tools\\freellmapi';

const say = (m) => fs.appendFileSync(path.join(LOGS, 'supervisor.log'), `${new Date().toISOString()} ${m}\n`);

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

const services = [
  { name: 'freellmapi', port: 3001, cwd: FREELLM, args: ['server/dist/index.js'], need: path.join(FREELLM, 'server', 'dist', 'index.js') },
  { name: 'studio', port: 4600, cwd: ROOT, args: ['server/server.js'], need: path.join(ROOT, 'server', 'server.js') },
];

const state = {};
async function keep(svc) {
  const st = state[svc.name] || (state[svc.name] = { child: null, fails: 0 });
  if (st.child) return;
  if (await portBusy(svc.port)) return; // already running (started by hand) — leave it alone
  if (!fs.existsSync(svc.need)) { if (!st.warned) say(`${svc.name}: ${svc.need} not found, skipping`); st.warned = true; return; }
  const log = fs.openSync(path.join(LOGS, svc.name + '.log'), 'a');
  say(`starting ${svc.name}`);
  st.child = spawn(process.execPath, svc.args, { cwd: svc.cwd, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, NODE_ENV: 'production' } });
  st.started = Date.now();
  st.child.on('exit', (code) => {
    say(`${svc.name} stopped (code ${code})`);
    st.child = null;
    st.fails = Date.now() - st.started < 60000 ? st.fails + 1 : 0;
    try { fs.closeSync(log); } catch {}
  });
}

// keep log files from growing forever
function trim() {
  for (const f of fs.readdirSync(LOGS)) {
    const p = path.join(LOGS, f);
    try { if (fs.statSync(p).size > 5e6) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').slice(-1e6)); } catch {}
  }
}

async function tick() {
  for (const svc of services) {
    const st = state[svc.name];
    // after repeated quick crashes, wait longer before trying again (10 s, 20 s … up to 5 min)
    if (st && !st.child && st.fails && Date.now() - (st.lastTry || 0) < Math.min(300000, 10000 * 2 ** (st.fails - 1))) continue;
    if (st) st.lastTry = Date.now();
    await keep(svc).catch((e) => say(`${svc.name}: ${e.message}`));
  }
}

say('supervisor started');
tick();
setInterval(tick, 10000);
setInterval(trim, 3600000);
process.on('uncaughtException', (e) => say('error: ' + e.message));

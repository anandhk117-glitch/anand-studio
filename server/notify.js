// Phone notifications through ntfy (free app for Android/iPhone, no account needed).
// Install "ntfy", subscribe to the same secret topic name you put in Settings.
const store = require('./store');
const path = require('path');
const LOG = path.join(store.P.data, 'notifications.json');

// Sign-in / human-check alerts open the Live page (works from the phone on the same Wi-Fi).
function liveUrl(text) {
  if (!/sign in|signed in|verify|human|login/i.test(text)) return null;
  const os = require('os');
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).map((a) => ({ ...a, name }))).filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
  const pick = all.find((a) => /wi-?fi|wlan|wireless/i.test(a.name)) || all.find((a) => /ethernet/i.test(a.name)) || all.find((a) => !/tun|vpn|proton|tap|virtual|vethernet/i.test(a.name)) || all[0];
  if (pick) return `http://${pick.address}:${process.env.STUDIO_PORT || 4600}/live.html`;
  return 'http://localhost:4600/live.html';
}
async function send(text, { project, title = 'YouTube Studio', priority = 3 } = {}) {
  const log = store.readJSON(LOG, []);
  log.unshift({ t: new Date().toISOString(), text, project: project || null });
  store.writeJSON(LOG, log.slice(0, 200));
  const topic = store.getSettings().ntfy_topic;
  if (!topic) return { ok: false, error: 'No ntfy topic set — saved in the Studio only.' };
  try {
    const r = await fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
      method: 'POST', body: text,
      headers: { Title: title, Priority: String(priority), Click: liveUrl(text) || (project ? `http://localhost:4600/#/p/${project}` : 'http://localhost:4600/') },
      signal: AbortSignal.timeout(10000),
    });
    return { ok: r.ok, error: r.ok ? null : 'ntfy answered ' + r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}
const recent = () => store.readJSON(LOG, []).slice(0, 50);
module.exports = { send, recent };

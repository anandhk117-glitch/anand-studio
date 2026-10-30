// YouTube Data API v3 with your own free key (10,000 units/day).
// search.list = 100 units, videos.list / channels.list = 1 unit.
const { getSettings, P, writeJSON, readJSON } = require('./store');
const path = require('path');

const API = 'https://www.googleapis.com/youtube/v3/';

async function yt(endpoint, params) {
  const key = getSettings().youtube_api_key;
  if (!key) throw new Error('No YouTube API key yet. Add it in Settings.');
  const q = new URLSearchParams({ ...params, key });
  const r = await fetch(API + endpoint + '?' + q, { signal: AbortSignal.timeout(20000) });
  const data = await r.json();
  if (!r.ok) {
    const reason = data.error?.errors?.[0]?.reason || r.status;
    if (r.status === 403) throw new Error(`YouTube refused (${reason}). Wrong key, or today's quota is used up.`);
    throw new Error(`YouTube error: ${data.error?.message || reason}`);
  }
  return data;
}

const daysSince = (d) => Math.max(1, (Date.now() - new Date(d).getTime()) / 86400000);

// What is pulling views in this niche right now. Cost ≈ 100 × keywords + 2.
async function nicheScan(channel, { days = 45, perKeyword = 15 } = {}) {
  const kw = (channel.research?.keywords || []).slice(0, 4);
  if (!kw.length) return { videos: [], note: 'No research keywords in this channel config.' };
  const after = new Date(Date.now() - days * 86400000).toISOString();
  const ids = new Set();
  for (const k of kw) {
    const s = await yt('search', { part: 'snippet', q: k, type: 'video', order: 'viewCount', publishedAfter: after,
      maxResults: perKeyword, relevanceLanguage: channel.lang_code || 'en', regionCode: channel.research?.region || 'IN' });
    s.items.forEach((i) => ids.add(i.id.videoId));
  }
  const list = [...ids];
  const vids = [];
  for (let i = 0; i < list.length; i += 50) {
    const v = await yt('videos', { part: 'snippet,statistics,contentDetails', id: list.slice(i, i + 50).join(',') });
    vids.push(...v.items);
  }
  const chIds = [...new Set(vids.map((v) => v.snippet.channelId))];
  const subs = {};
  for (let i = 0; i < chIds.length; i += 50) {
    const c = await yt('channels', { part: 'statistics', id: chIds.slice(i, i + 50).join(',') });
    c.items.forEach((x) => (subs[x.id] = +x.statistics.subscriberCount || 0));
  }
  const rows = vids.map((v) => {
    const views = +v.statistics.viewCount || 0;
    const s = subs[v.snippet.channelId] || 0;
    return {
      title: v.snippet.title, channel: v.snippet.channelTitle, published: v.snippet.publishedAt.slice(0, 10),
      views, views_per_day: Math.round(views / daysSince(v.snippet.publishedAt)), subs: s,
      outlier: s ? +(views / s).toFixed(2) : null, duration: v.contentDetails.duration,
      url: 'https://youtu.be/' + v.id,
    };
  }).sort((a, b) => b.views_per_day - a.views_per_day);
  const out = { channel: channel.id, scanned: new Date().toISOString(), keywords: kw, videos: rows.slice(0, 30) };
  writeJSON(path.join(P.stats, channel.id + '_niche.json'), out);
  return out;
}

// Your own channel numbers. Cost ≈ 1–3 units.
async function channelStats(channel) {
  const handle = channel.youtube?.handle;
  const id = channel.youtube?.channel_id;
  if (!handle && !id) return null;
  const params = { part: 'statistics,snippet' };
  if (id) params.id = id; else params.forHandle = handle.replace(/^@/, '');
  const d = await yt('channels', params);
  const c = d.items?.[0];
  if (!c) return { error: 'Channel not found — check the handle in config/channels/' + channel.id + '.json' };
  const out = {
    fetched: new Date().toISOString(), title: c.snippet.title,
    subscribers: +c.statistics.subscriberCount || 0, views: +c.statistics.viewCount || 0, videos: +c.statistics.videoCount || 0,
  };
  const file = path.join(P.stats, channel.id + '.json');
  const hist = readJSON(file, { history: [] });
  hist.latest = out;
  hist.history = [...(hist.history || []).filter((h) => h.fetched.slice(0, 10) !== out.fetched.slice(0, 10)), out].slice(-365);
  writeJSON(file, hist);
  return out;
}

function cachedStats(channelId) {
  return readJSON(path.join(P.stats, channelId + '.json'), null)?.latest || null;
}
function cachedNiche(channelId) {
  return readJSON(path.join(P.stats, channelId + '_niche.json'), null);
}

module.exports = { nicheScan, channelStats, cachedStats, cachedNiche };

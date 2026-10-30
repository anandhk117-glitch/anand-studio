#!/usr/bin/env node
// Command line for the Claude Code agent (and for you). The Studio must be running.
//   node tools/agent.js list                         open requests
//   node tools/agent.js next                         full instructions for the oldest open request
//   node tools/agent.js show <taskId>                full instructions for one request
//   node tools/agent.js done <taskId> [result.json]  finish a request (writing jobs pass their JSON)
//   node tools/agent.js cancel <taskId>
//   node tools/agent.js note-task <taskId> "why it is blocked"
//   node tools/agent.js attach <projectId> audio <file> [A|B|narration]
//   node tools/agent.js attach <projectId> image|video <file> <sceneNumber>
//   node tools/agent.js attach <projectId> thumbnail <file>
//   node tools/agent.js status <projectId>
//   node tools/agent.js lesson <channel> "what we learned"
//   node tools/agent.js songs <channel>             past songs (to avoid repeats)
//   node tools/agent.js new-song <channel> <song.json>   start a project from an approved song package → prints the project id
const fs = require('fs');
const path = require('path');
const BASE = process.env.STUDIO_URL || 'http://localhost:4600';

async function api(method, url, body, raw) {
  let r;
  try {
    r = await fetch(BASE + url, { method, body: raw ? body : body ? JSON.stringify(body) : undefined,
      headers: raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' } });
  } catch { die(`The Studio is not running at ${BASE}. Start it with "Start Studio.bat" (or: node server/server.js).`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(j.error || `HTTP ${r.status}`);
  return j;
}
function die(m) { console.error('✗ ' + m); process.exit(1); }

const [cmd, ...a] = process.argv.slice(2);
(async () => {
  switch (cmd) {
    case 'songs': {
      const { songs } = await api('GET', `/api/channels/${a[0]}/songs`);
      for (const x of songs) console.log(`${(x.created || '').slice(0, 10)}  ${x.title}${x.title_en ? '  (' + x.title_en + ')' : ''}`);
      if (!songs.length) console.log('No songs yet.');
      break;
    }
    case 'new-song': {
      const [ch, file] = a;
      if (!ch || !file) die('Usage: new-song <channel> <song.json>   (JSON: {"idea":{...},"song":{"title_native","title_en","style","lyrics","retention_notes"}})');
      const body = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const { id } = await api('POST', `/api/channels/${ch}/new-song`, body.song ? body : { song: body });
      console.log(id);
      break;
    }
    case 'list': {
      const { queue } = await api('GET', '/api/queue');
      const open = queue.filter((t) => t.status === 'open');
      if (!open.length) return console.log('No open requests.');
      for (const t of open) console.log(`${t.id}  ${t.kind.padEnd(7)}  ${t.title}${t.note ? '  — note: ' + t.note : ''}`);
      break;
    }
    case 'next':
    case 'show': {
      let id = a[0];
      if (cmd === 'next') {
        const { queue } = await api('GET', '/api/queue');
        const open = queue.filter((t) => t.status === 'open');
        if (!open.length) return console.log('No open requests.');
        id = open[open.length - 1].id;
      }
      const b = await api('GET', `/api/queue/${id}/brief`);
      console.log(`TASK ${b.task.id} · ${b.task.title} · ${b.task.agent}\n${b.task.note ? 'Anand\'s note: ' + b.task.note + '\n' : ''}\n${b.instructions}\n\n→ ${b.finish}`);
      break;
    }
    case 'done': {
      const [id, file] = a;
      if (!id) die('Usage: done <taskId> [result.json]');
      let body = {};
      if (file) { try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die('Could not read JSON from ' + file + ': ' + e.message); } }
      const r = await api('POST', `/api/queue/${id}/done`, body);
      console.log('✓ Done: ' + r.task.title);
      break;
    }
    case 'note-task': await api('POST', `/api/queue/${a[0]}/note`, { text: a.slice(1).join(' ') }); console.log('✓ Marked as blocked — Anand will see why'); break;
    case 'cancel': await api('POST', `/api/queue/${a[0]}/cancel`); console.log('✓ Cancelled'); break;
    case 'attach': {
      const [pid, kind, file, extra] = a;
      if (!pid || !kind || !file) die('Usage: attach <projectId> <audio|image|video|thumbnail> <file> [label|scene]');
      if (!fs.existsSync(file)) die('No such file: ' + file);
      const q = new URLSearchParams({ kind, name: path.basename(file) });
      if (kind === 'audio' && extra) q.set('label', extra);
      if ((kind === 'image' || kind === 'video') && extra) q.set('scene', extra);
      const r = await api('POST', `/api/projects/${pid}/upload?${q}`, fs.readFileSync(file), true);
      console.log('✓ Attached as ' + r.file);
      break;
    }
    case 'status': {
      const { project: p } = await api('GET', `/api/projects/${a[0]}`);
      console.log(`${p.title || p.id} — ${p.progress.pct}% — now: ${p.progress.current}`);
      for (const s of p.progress.stages) console.log(`  ${s.status.padEnd(8)} ${s.label}`);
      const sc = p.scenes || [];
      if (sc.length) console.log(`  scenes ${sc.length} · images ${sc.filter((s) => s.image).length} · videos ${sc.filter((s) => s.video).length}`);
      break;
    }
    case 'lesson': await api('POST', `/api/channels/${a[0]}/lesson`, { text: a.slice(1).join(' ') }); console.log('✓ Lesson saved'); break;
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
})();

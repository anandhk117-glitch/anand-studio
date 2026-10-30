// The work, layer by layer. Each stage has one agent and one job.
// mode: how the agent works
//   llm     – writes with free tokens (FreeLLMAPI) or hands the job to Claude Code
//   auto    – the Studio does it itself on your PC (ffmpeg / maths)
//   browser – needs your logged-in browser (Suno, Flow, Grok…): Claude Code + Chrome, or you upload
const AGENTS = {
  research: { name: 'Research agent', job: 'Studies what is trending in this niche and brings 4 ideas that can go viral.', tools: ['YouTube Data API', 'Free LLM', 'vidIQ (via Claude Code)', 'niche_intel'], mode: 'llm' },
  song: { name: 'Songwriter', job: 'Writes the lyrics with section tags, the Suno style (under 200 characters) and the title.', tools: ['Free LLM or Claude'], mode: 'llm' },
  script: { name: 'Script writer', job: 'Writes the documentary narration in the Decoder voice, section by section.', tools: ['Free LLM or Claude'], mode: 'llm' },
  music: { name: 'Music producer', job: 'Makes the song on Suno (two versions) or a free music app, then brings the files here.', tools: ['Suno (browser)', 'ACE-Step (free, local)'], mode: 'browser' },
  voice: { name: 'Voice producer', job: 'Records or generates the narration and brings the audio file here.', tools: ['Your voice', 'Free TTS app', 'vidIQ voiceover'], mode: 'browser' },
  pick: { name: 'Music analyst', job: 'Measures both versions (length, loudness, how fast the singing starts) and recommends one.', tools: ['ffmpeg'], mode: 'auto' },
  timeline: { name: 'Timeline mapper', job: 'Times every lyric line and cuts the song into 5–10 second scenes.', tools: ['ffmpeg', 'Suno word timestamps'], mode: 'auto' },
  images: { name: 'Visual director', job: 'Writes one image prompt per scene with the locked characters, then makes the images.', tools: ['Free LLM or Claude', 'Google Flow (browser)', 'Hugging Face (free)'], mode: 'llm' },
  videos: { name: 'Motion director', job: 'Writes the motion prompt for each scene and turns images into clips — Wan 3.0 automatically, or browser tools.', tools: ['Wan 3.0 API (automatic)', 'Grok → Kling → Hailuo (browser)', 'Seedance on Dola (browser)'], mode: 'browser' },
  edit: { name: 'Editor', job: 'Joins intro, all scenes, music, logo, lyrics and outro into the finished video.', tools: ['ffmpeg'], mode: 'auto' },
  publish: { name: 'Publisher', job: 'Writes titles, description with timestamps, tags and the thumbnail idea, and runs the upload checklist.', tools: ['Free LLM or Claude', 'vidIQ (via Claude Code)'], mode: 'llm' },
};

const PIPELINES = {
  kids_song: ['research', 'song', 'music', 'pick', 'timeline', 'images', 'videos', 'edit', 'publish'],
  documentary: ['research', 'script', 'voice', 'timeline', 'images', 'videos', 'edit', 'publish'],
  reel: ['research', 'script', 'voice', 'images', 'edit', 'publish'], // ReelBite: sourced story Shorts — real photos, headline cards, charts, comic panels
};

const STAGE_LABEL = {
  research: 'Research', song: 'Song', script: 'Script', music: 'Music', voice: 'Narration', pick: 'Pick version',
  timeline: 'Timeline', images: 'Images', videos: 'Videos', edit: 'Edit', publish: 'Publish',
};

function stagesFor(pipeline) { return PIPELINES[pipeline] || PIPELINES.kids_song; }

// Works out where a project stands from what it actually contains.
function progress(p) {
  const order = stagesFor(p.pipeline);
  const scenes = p.scenes || [];
  const done = {
    research: !!p.idea,
    song: !!(p.song && p.song.approved),
    script: !!(p.script && p.script.approved),
    music: (p.audio || []).length > 0,
    voice: (p.audio || []).length > 0,
    pick: !!p.picked_audio,
    timeline: !!(p.timeline && p.timeline.approved),
    images: scenes.length > 0 && scenes.every((s) => s.image),
    videos: scenes.length > 0 && (scenes.every((s) => s.video) || (!!p.allow_image_scenes && p.pipeline !== 'kids_song')), // kids songs: every scene moves, never a still
    edit: !!(p.edit && p.edit.approved),
    publish: !!(p.publish && p.publish.approved),
  };
  if (p.pipeline === 'documentary') done.pick = done.voice;
  let current = order.find((s) => !done[s]) || 'finished';
  const stages = order.map((s) => ({
    key: s, label: STAGE_LABEL[s], agent: AGENTS[s].name, mode: AGENTS[s].mode,
    status: done[s] ? 'done' : s === current ? (waiting(p, s) ? 'waiting' : (p.busy && p.busy.stage === s ? 'working' : 'now')) : 'todo',
  }));
  const pct = Math.round((order.filter((s) => done[s]).length / order.length) * 100);
  return { current, stages, pct };
}

// "Waiting for you" = the agent finished, a human decision is needed.
function waiting(p, s) {
  switch (s) {
    case 'research': return (p.ideas || []).length > 0 && !p.idea;
    case 'song': return !!(p.song && p.song.lyrics) && !p.song.approved;
    case 'script': return !!(p.script && p.script.text) && !p.script.approved;
    case 'pick': return (p.audio || []).length > 0 && !p.picked_audio;
    case 'timeline': return !!(p.timeline && (p.timeline.lines || []).length) && !p.timeline.approved;
    case 'edit': return !!(p.edit && p.edit.file) && !p.edit.approved;
    case 'publish': return !!(p.publish && (p.publish.titles || []).length) && !p.publish.approved;
    default: return false;
  }
}

module.exports = { AGENTS, PIPELINES, STAGE_LABEL, stagesFor, progress, waiting };

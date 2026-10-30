// Shows a Hugging Face Space's API so it can be added to config/hf_spaces.json.
//   node tools/probe_space.js <owner/space or host> [...more]
(async () => {
  for (const arg of process.argv.slice(2)) {
    const host = arg.includes('.hf.space') ? arg : arg.toLowerCase().replace(/[/_.]/g, '-') + '.hf.space';
    try {
      const r = await fetch(`https://${host}/gradio_api/info`, { signal: AbortSignal.timeout(25000) });
      console.log(`== ${arg} → ${host} (${r.status})`);
      if (!r.ok) continue;
      const j = await r.json();
      for (const [name, v] of Object.entries(j.named_endpoints || {})) {
        console.log(`  ${name}`);
        for (const p of v.parameters) console.log(`     - ${p.parameter_name} (${p.python_type?.type?.slice(0, 50)}) default=${JSON.stringify(p.parameter_default)}`);
        console.log(`     → returns ${(v.returns || []).map((x) => x.python_type?.type?.slice(0, 40)).join(', ')}`);
      }
    } catch (e) { console.log(`== ${arg}: ${e.message}`); }
  }
})();

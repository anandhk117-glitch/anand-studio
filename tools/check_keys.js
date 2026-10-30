const path=require('path'); const R=(m)=>require(path.join(__dirname,'..','server',m));
const s=R('store').getSettings();
const t=async(n,f)=>{try{console.log(n, await f())}catch(e){console.log(n,'ERROR',e.message.slice(0,200))}};
(async()=>{
const k=(v)=>v?('set, starts '+v.slice(0,4)+'…, length '+v.length):'EMPTY';
console.log('aistudio',k(s.aistudio_api_key),'| google',k(s.google_api_key),'| hf',k(s.hf_token),'| yt',k(s.youtube_api_key),'| llm',k(s.llm_api_key),'| ntfy',s.ntfy_topic?'set':'EMPTY','| wan',k(s.wan_api_key));
await t('AI Studio:',async()=>{const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${s.aistudio_model}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':s.aistudio_api_key},body:JSON.stringify({contents:[{parts:[{text:'Reply with exactly: OK'}]}]})});const j=await r.json();return r.status+' '+(j.candidates?.[0]?.content?.parts?.map(p=>p.text).join('')||JSON.stringify(j.error||j).slice(0,250))});
await t('HF:',async()=>{const r=await fetch('https://huggingface.co/api/whoami-v2',{headers:{Authorization:'Bearer '+s.hf_token}});const j=await r.json();return r.status+' '+(j.name||JSON.stringify(j).slice(0,150))+' role='+(j.auth?.accessToken?.role||'?')});
await t('YouTube:',async()=>{const r=await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&id=UCAASNEkozpjr0vC-xrqTSXg&key='+s.youtube_api_key);const j=await r.json();return r.status+' '+(j.items?.[0]?.snippet?.title||JSON.stringify(j.error?.message||j).slice(0,150))});
await t('FreeLLMAPI:',async()=>{const r=await fetch(s.llm_base_url.replace(/\/$/,'')+'/models',{headers:{Authorization:'Bearer '+s.llm_api_key}});const j=await r.json();return r.status+' models='+(j.data?.length??JSON.stringify(j).slice(0,120))});
await t('Brain chat():',async()=>{const r=await R('llm').chat([{role:'user',content:'Reply with exactly: OK'}],{});return JSON.stringify(r).slice(0,200)});
})();

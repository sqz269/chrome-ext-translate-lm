// Explicit live API benchmark; bills the configured Vertex project.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
if (!process.argv.includes('--go')) throw Error('Use --go to run paid inference.');
const lab = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\sqz269\\vllm-translation-lab\\mangaset-eval';
const root = 'C:/Users/sqz269/Downloads/MangaSet-review/vertex-translations';
fs.mkdirSync(root, {recursive:true});
const output = path.join(root,'results.jsonl');
if (fs.existsSync(output)) throw Error('Results already exist; preserve them before starting a new run.');
let settings = {gemmaProfileVersion:2,provider:'vertex36',endpoint:'http://127.0.0.1:8001/v1/chat/completions',model:'gemini-3.6-flash-minimal',gemmaVllm:false,gemmaImageVerification:true,targetLang:'English'};
let stats = [];
const chrome = {
  declarativeNetRequest:{getSessionRules:async()=>[],updateSessionRules:async()=>{}},
  storage:{sync:{get:async()=>({...settings}),set:async v=>Object.assign(settings,v)},local:{get:async()=>({}),set:async()=>{}}},
  runtime:{onInstalled:{addListener(){}}},contextMenus:{onClicked:{addListener(){}}}
};
const ctx = vm.createContext({chrome,console,performance,TextDecoder,setInterval,clearInterval,crypto,fetch});
const source = fs.readFileSync(path.join(__dirname,'../background.js'),'utf8');
vm.runInContext(source,ctx);ctx.recordStat=async s=>stats.push(s);
const prior = fs.readFileSync(path.join(lab,'combined-translation-augmented.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({source_sha256:crypto.createHash('sha256').update(source).digest('hex'),settings,method:'Actual extension functions and local Vertex adapter. Shared saved OCR for translation comparison, plus fresh Gemini36 detection+verification. Existing 14 meaning checks evaluated separately; references not sent.'},null,2));
async function measured(fn) {stats=[];const start=performance.now();const result=await fn();return {result,seconds:(performance.now()-start)/1000,stats:[...stats]};}
(async()=>{
  const text = await measured(()=>ctx.translateText('コーヒーどうぞ。'));
  fs.writeFileSync(path.join(root,'text-smoke.json'),JSON.stringify(text,null,2));
  for (const page of prior) {
    const dataUrl='data:image/png;base64,'+fs.readFileSync(`C:/Users/sqz269/Downloads/MangaSet-review/inference-png/${page.id}.png`).toString('base64');
    ctx.grabImage=async()=>({dataUrl,method:'benchmark inline PNG'});
    const row={id:page.id,sharedOCR:page.regions,variants:{}};
    for (const [provider,model] of [['vertex36','gemini-3.6-flash-minimal'],['vertex38','gemini-3.8-flash-low']]) {
      settings={...settings,provider,model};
      row.variants[provider]=await measured(()=>ctx.verifyImageRegions(page.regions,settings,dataUrl));
      console.log(page.id,provider,'shared OCR translation',row.variants[provider].seconds.toFixed(2),'s');
    }
    settings={...settings,provider:'vertex36',model:'gemini-3.6-flash-minimal'};
    row.pipeline=await measured(()=>ctx.detectAndTranslate('fixture-image'));
    console.log(page.id,'fresh 36 pipeline',row.pipeline.seconds.toFixed(2),'s');
    fs.appendFileSync(output,JSON.stringify(row)+'\n');
  }
})().catch(error=>{console.error(error);process.exitCode=1;});

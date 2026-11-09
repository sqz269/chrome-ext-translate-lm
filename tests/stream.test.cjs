const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../background.js'),'utf8');
const parser=source.slice(source.indexOf('async function readSSE('),source.indexOf('// Ring buffer'));
const readSSE=vm.runInNewContext(parser+';readSSE',{TextDecoder,performance});
function stream(events){
  const bytes=new TextEncoder().encode(events.map(e=>'data:'+JSON.stringify(e)+'\r\n\r\n').join('')+'data: [DONE]\n\n');
  return new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}});
}
test('fragmented UTF-8 SSE separates thinking from answer and preserves usage / output limit',async()=>{
  const live={tokens:0};
  const result=await readSSE(stream([
    {choices:[{delta:{reasoning_content:'Think'}}]},
    {choices:[{delta:{content:'こんにちは'}}]},
    {choices:[{delta:{},finish_reason:'length'}],usage:{completion_tokens:42}}
  ]),performance.now(),live);
  assert.equal(result.content,'こんにちは');
  assert.equal(result.finishReason,'length');
  assert.equal(result.usage.completion_tokens,42);
  assert.ok(result.ttft>=0);
  assert.equal(live.phase,'Writing answer…');
});
test('reasoning-only stream reports first token and thinking phase',async()=>{
  const live={tokens:0};
  const result=await readSSE(stream([{choices:[{delta:{reasoning:'Reason'}}]}]),performance.now(),live);
  assert.equal(result.content,'');assert.ok(result.ttft>=0);assert.equal(live.phase,'Thinking…');
});
test('stream errors are surfaced',async()=>{
  await assert.rejects(readSSE(stream([{error:{message:'Model unavailable'}}]),performance.now(),{}),/Model unavailable/);
});

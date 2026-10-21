'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {setTimeout: delay}=require('node:timers/promises');
const PORT=31000+Math.floor(Math.random()*3000);
const base=`http://127.0.0.1:${PORT}`;

async function startServer(){
  const cp=spawn(process.execPath,['server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,PORT:String(PORT)},stdio:'pipe'});
  for(let i=0;i<80;i++){
    try{const r=await fetch(base+'/health');if(r.ok)return cp;}catch(_){}
    await delay(40);
  }
  cp.kill();throw new Error('server failed to start');
}
async function post(endpoint,payload,expected=200){const r=await fetch(`${base}/api/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();assert.equal(r.status,expected,`expected ${expected}, got ${r.status}: ${JSON.stringify(d)}`);return d;}
async function state(session){const r=await fetch(`${base}/api/state?code=${session.code}&token=${session.token}`);assert.equal(r.status,200);return r.json();}

test('Five devices receive exclusive prompts, vote privately, auto-advance and keep identity hidden',async()=>{
  const cp=await startServer();
  try{
    const host=await post('create',{name:'A'});
    const sessions=[host];
    for(const name of ['B','C','D','E'])sessions.push(await post('join',{code:host.code,name}));
    assert.equal((await state(host)).players.length,5);
    await post('start',host);
    const states=await Promise.all(sessions.map(state));
    assert.ok(states.every(s=>s.phase==='sing'&&typeof s.prompt==='string'));
    assert.deepEqual(states.map(s=>s.me.id),[1,2,3,4,5]);
    assert.equal(new Set(states.map(s=>s.prompt)).size,2);
    const prompts=new Map();states.forEach(s=>prompts.set(s.prompt,(prompts.get(s.prompt)||0)+1));
    assert.deepEqual([...prompts.values()].sort((a,b)=>a-b),[1,4]);
    const spy=states.find(s=>prompts.get(s.prompt)===1).me.id;
    assert.ok(states.every(s=>s.reveal===null && !('spyId' in s)));
    await post('open-vote',host);
    const target=spy;
    for(let i=0;i<5;i++){
      const id=i+1;
      const victim=id===target ? (target%5)+1 : target;
      await post('vote',{...sessions[i],target:victim});
    }
    const done=await state(host);
    assert.equal(done.phase,'finished');
    assert.equal(done.winner,'civilian');
    assert.equal(done.reveal,null);
    assert.equal(done.lastResult.outId,spy);
    await post('reveal',host);
    assert.equal((await state(sessions[3])).reveal.spyId,spy);
    await post('restart',host);
    const restarted=await state(sessions[3]);
    assert.equal(restarted.phase,'sing');
    assert.equal(restarted.round,1);
    assert.equal(restarted.reveal,null);
    assert.equal(restarted.roundsPlayed,2);
  }finally{cp.kill();}
});

test('Host-only actions, self-vote ban and server-side privacy',async()=>{
  const cp=await startServer();
  try{
    const h=await post('create',{name:'主持人'});
    const b=await post('join',{code:h.code,name:'路人'});
    await post('start',h,400);
    await post('open-vote',b,403);
    await post('vote',{...b,target:1},400);
    const st=await state(b);
    assert.equal(st.phase,'lobby');
    assert.equal(st.prompt,null);
    assert.equal(st.reveal,null);
    await post('kick',{...h,target:2});
    assert.equal((await state(h)).players.length,1);
    const r=await fetch(`${base}/api/state?code=${h.code}&token=${b.token}`);
    assert.equal(r.status,403);
  }finally{cp.kill();}
});

test('SSE pushes new room state to other connected players',async()=>{
  const cp=await startServer();
  try {
    const host=await post('create',{name:'First'});
    const response=await fetch(`${base}/api/events?code=${host.code}&token=${host.token}`,{headers:{Accept:'text/event-stream'}});
    assert.equal(response.status,200);
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let buffer='';
    async function getMessage(){
      while(true){
        let at=buffer.indexOf('\n\n');
        if(at!==-1){const msg=buffer.slice(0,at);buffer=buffer.slice(at+2);const line=msg.split('\n').find(s=>s.startsWith('data: '));if(line)return JSON.parse(line.slice(6));}
        const result=await Promise.race([reader.read(),delay(1500).then(()=>{throw new Error('SSE did not deliver');})]);
        if(result.done)throw new Error('SSE closed early');buffer+=decoder.decode(result.value);
      }
    }
    assert.equal((await getMessage()).players.length,1);
    await post('join',{code:host.code,name:'Second'});
    assert.equal((await getMessage()).players.length,2);
    await reader.cancel();
  }finally{cp.kill();}
});
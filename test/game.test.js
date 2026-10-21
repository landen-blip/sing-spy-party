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
    await post('start',h,400);
    const b=await post('join',{code:h.code,name:'路人'});
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

test('2-player duel gives four private choices and finishes after two valid guesses',async()=>{
  const cp=await startServer();
  try{
    const host=await post('create',{name:'Host',capacity:2});
    const other=await post('join',{code:host.code,name:'Guest'});
    await post('join',{code:host.code,name:'TooLate'},400);
    await post('start',host);
    const [h,g]=await Promise.all([state(host),state(other)]);
    assert.equal(h.isDuel,true);
    assert.equal(h.maxPlayers,2);
    assert.equal(h.phase,'sing');
    assert.notEqual(h.prompt,g.prompt);
    assert.equal(h.duelChoices,null);
    await post('open-vote',host);
    const [hv,gv]=await Promise.all([state(host),state(other)]);
    assert.equal(hv.phase,'duel_guess');
    assert.equal(hv.duelChoices.length,4);
    assert.equal(gv.duelChoices.length,4);
    assert.equal(new Set(hv.duelChoices).size,4);
    assert.ok(hv.duelChoices.includes(g.prompt));
    assert.ok(gv.duelChoices.includes(h.prompt));
    assert.equal(hv.reveal,null);
    await post('vote',{...host,target:2},400);
    await post('guess',{...host,choice:4},400);
    await post('guess',{...host,choice:hv.duelChoices.indexOf(g.prompt)});
    await post('guess',{...host,choice:0},400);
    assert.equal((await state(host)).phase,'duel_guess');
    assert.equal((await state(other)).players.find(p=>p.id===1).hasVoted,true);
    const wrong=gv.duelChoices.findIndex(x=>x!==h.prompt);
    await post('guess',{...other,choice:wrong});
    const finished=await state(host);
    assert.equal(finished.phase,'finished');
    assert.equal(finished.winner,'duel');
    assert.deepEqual(finished.duelResult.correctIds,[1]);
    assert.equal(finished.duelResult.winnerId,1);
    assert.equal(finished.reveal,null);
    assert.equal(finished.players.every(p=>p.alive),true);
    await post('restart',host);
    const next=await state(other);
    assert.equal(next.phase,'sing');
    assert.equal(next.isDuel,true);
    assert.equal(next.reveal,null);
  }finally{cp.kill();}
});

test('Room size configurable from 2 to 10, starts early, rejects overflow',async()=>{
  const cp=await startServer();
  try{
    await post('create',{name:'tooSmall',capacity:1},400);
    await post('create',{name:'tooLarge',capacity:11},400);
    await post('create',{name:'invalid',capacity:2.5},400);
    for(const capacity of [3,4,6,8,10]){
      const host=await post('create',{name:'P1',capacity});
      const players=[host];
      for(let i=2;i<=capacity;i++)players.push(await post('join',{code:host.code,name:'P'+i}));
      const full=await state(host);
      assert.equal(full.maxPlayers,capacity);
      assert.equal(full.players.length,capacity);
      assert.deepEqual(full.players.map(p=>p.id),Array.from({length:capacity},(_,i)=>i+1));
      await post('join',{code:host.code,name:'Overflow'},400);
      await post('start',host);
      const sts=await Promise.all(players.map(state));
      assert.ok(sts.every(s=>s.phase==='sing' && s.isDuel===false));
      const freq=new Map();sts.forEach(s=>freq.set(s.prompt,(freq.get(s.prompt)||0)+1));
      assert.deepEqual([...freq.values()].sort((a,b)=>a-b),[1,capacity-1]);
      assert.ok(sts.every(s=>s.reveal===null && !('spyId' in s)));
      await post('open-vote',host);
      const voteStates=await Promise.all(players.map(state));
      assert.ok(voteStates.every(s=>s.phase==='voting'));
    }
    const earlyHost=await post('create',{name:'EarlyHost',capacity:10});
    const guest=await post('join',{code:earlyHost.code,name:'EarlyGuest'});
    const third=await post('join',{code:earlyHost.code,name:'Third'});
    await post('start',earlyHost);
    const sts=await Promise.all([earlyHost,guest,third].map(state));
    assert.equal(sts[0].isDuel,false);
    assert.equal(sts[0].players.length,3);
    await post('join',{code:earlyHost.code,name:'late'},400);
  }finally{cp.kill();}
});

test('3-player civilians lose when a civilian is eliminated, game stays private',async()=>{
  const cp=await startServer();
  try{
    const host=await post('create',{name:'A',capacity:3});
    const guests=[await post('join',{code:host.code,name:'B'}),await post('join',{code:host.code,name:'C'})];
    const sessions=[host,...guests];
    await post('start',host);
    const st=await Promise.all(sessions.map(state));
    const freq=new Map();st.forEach(s=>freq.set(s.prompt,(freq.get(s.prompt)||0)+1));
    const spy=st.find(s=>freq.get(s.prompt)===1).me.id;
    const civilian=st.find(s=>s.me.id!==spy).me.id;
    await post('open-vote',host);
    for(let i=0;i<3;i++){
      let target=civilian;
      if(st[i].me.id===civilian)target=(civilian%3)+1;
      await post('vote',{...sessions[i],target});
    }
    const end=await state(host);
    assert.equal(end.phase,'finished');
    assert.equal(end.winner,'spy');
    assert.equal(end.reveal,null);
  }finally{cp.kill();}
});


test('270 unique scenario pairs have no repeated prompt text',()=>{
  const pairs=require('../scenarios.json');
  assert.equal(pairs.length,270);
  const prompts=pairs.flatMap(pair=>[pair.common,pair.spy]);
  assert.ok(prompts.every(prompt=>prompt.trim().length>0));
  assert.equal(new Set(prompts).size,540);
});

test('A single room never repeats a scenario across 270 complete games',async()=>{
  const cp=await startServer();
  try {
    const host=await post('create',{name:'Host',capacity:2});
    const guest=await post('join',{code:host.code,name:'Guest'});
    const seen=new Set();
    for(let i=0;i<270;i++){
      await post(i===0?'start':'restart',host);
      const [h,g]=await Promise.all([state(host),state(guest)]);
      assert.notEqual(h.prompt,g.prompt);
      const pairKey=[h.prompt,g.prompt].sort().join(' / ');
      assert.equal(seen.has(pairKey),false,`pair reused in game ${i+1}`);
      seen.add(pairKey);
      assert.equal(h.roundsPlayed,i+1);
      await post('open-vote',host);
      await post('guess',{...host,choice:0});
      await post('guess',{...guest,choice:0});
      assert.equal((await state(host)).phase,'finished');
    }
    assert.equal(seen.size,270);
    const done=await post('restart',host,400);
    assert.match(done.error,/全部玩过/);
    assert.equal((await state(host)).roundsPlayed,270);
  }finally{cp.kill();}
});
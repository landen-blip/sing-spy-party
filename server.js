'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const ROOM_TTL = 12 * 60 * 60 * 1000;
const rooms = new Map();
const PAIRS = require('./scenarios.json');
const ASSETS = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'application/javascript; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};

function code() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  for (let i = 0; i < 5; i++) value += alphabet[crypto.randomInt(alphabet.length)];
  return value;
}
function reply(res, status, json) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(json));
}
function failure(message, status=400) {const e = new Error(message); e.status = status; throw e;}
function publicState(room, token) {
  const me = room.players.find(p => p.token === token);
  if (!me) failure('你的房间身份已失效，请重新加入。', 403);
  const counts = room.players.filter(p => p.alive).length;
  return {
    code:room.code, phase:room.phase, round:room.round,
    isHost:me.token === room.hostToken, me:{id:me.id, name:me.name, alive:me.alive},
    players:room.players.map(p=>({id:p.id,name:p.name,alive:p.alive,hasVoted:room.isDuel && room.phase==='duel_guess' ? p.guess!==null : p.vote!==null})),
    maxPlayers:room.capacity, minPlayers:MIN_PLAYERS, activeCount:counts, isDuel:room.isDuel,
    // Only the actual spy receives this field; other players cannot inspect anyone's role.
    ...(room.phase !== 'lobby' && !room.isDuel && me.id === room.spyId ? {myRole:'spy'} : {}),
    prompt:(room.phase !== 'lobby' && me.alive && room.phase !== 'finished') ? (me.id === room.spyId ? room.pair.spy : room.pair.common) :
      (room.phase === 'finished' && me.alive ? (me.id === room.spyId ? room.pair.spy : room.pair.common) : null),
    myVote:me.vote, eligible:room.voteChoices || null,
    duelChoices:room.isDuel && room.phase === 'duel_guess' ? me.duelChoices : null,
    myGuess:room.isDuel ? me.guess : null,
    duelResult:room.isDuel && room.phase === 'finished' ? room.duelResult : null,
    lastResult:room.lastResult,
    winner:room.winner,
    reveal:room.revealed ? {spyId:room.spyId, common:room.pair.common, spy:room.pair.spy} : null,
    roundsPlayed:room.roundsPlayed,
  };
}
function dispatch(room) {
  room.updatedAt = Date.now();
  for (const subscriber of [...room.subscribers]) {
    try {subscriber.res.write(`data: ${JSON.stringify(publicState(room,subscriber.token))}\n\n`);} catch (_) {room.subscribers.delete(subscriber);}
  }
}
function auth(payload) {
  const room = rooms.get(String(payload.code || '').toUpperCase().trim());
  if (!room) failure('房间不存在或已过期，请检查房间号。', 404);
  const me = room.players.find(p=>p.token === payload.token);
  if (!me) failure('身份无效，请使用原来的设备或重新进入。', 403);
  return {room,me};
}
function shuffled(values) {
  const arr = [...values];
  for(let i=arr.length-1;i>0;i--) {
    const j=crypto.randomInt(i+1);
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function resetGame(room) {
  // A room never sees the same pair twice, including across consecutive games.
  const pairCandidates = PAIRS.map((_, i)=>i).filter(i=>!room.usedPairIndices.has(i));
  if(pairCandidates.length===0) failure('本房间的270组情景已全部玩过。为了避免重复，请创建一个新房间。');
  const pairIndex = pairCandidates[crypto.randomInt(pairCandidates.length)];
  room.usedPairIndices.add(pairIndex);
  room.pair = PAIRS[pairIndex];
  const spy = room.players[crypto.randomInt(room.players.length)];
  room.spyId = spy.id;
  room.isDuel = room.players.length === 2;
  room.duelResult = null;
  room.players.forEach(p=>{p.alive=true;p.vote=null;p.guess=null;p.duelChoices=null;});
  if(room.isDuel) {
    const allScenes = [...new Set(PAIRS.flatMap(pair=>[pair.common,pair.spy]))];
    for(const p of room.players) {
      const other = room.players.find(other=>other.id!==p.id);
      const correct = other.id===room.spyId ? room.pair.spy : room.pair.common;
      const myScene = p.id===room.spyId ? room.pair.spy : room.pair.common;
      const distractors = shuffled(allScenes.filter(scene=>scene!==correct && scene!==myScene)).slice(0,3);
      p.duelChoices = shuffled([correct,...distractors]);
    }
  }
  room.round = 1;
  room.voteChoices = null;
  room.phase = 'sing';
  room.lastResult = null;
  room.winner = null;
  room.revealed = false;
  room.roundsPlayed++;
}
function requireHost(room,me) {if (room.hostToken !== me.token) failure('只有房主可以进行这个操作。',403);}
function voteResult(room) {
  const alive=room.players.filter(p=>p.alive);
  const votes=alive.map(p=>p.vote);
  const counts=new Map();
  votes.forEach(id=>counts.set(id,(counts.get(id)||0)+1));
  const max=Math.max(...counts.values());
  const tied=[...counts.entries()].filter(([,n])=>n===max).map(([id])=>id);
  if(tied.length>1) {
    room.phase='tie';
    room.voteChoices=tied;
    room.lastResult={type:'tie', candidates:tied, message:'最高票平票！请在并列玩家中重新投票。'};
    room.players.forEach(p=>p.vote=null);
    return;
  }
  const out=room.players.find(p=>p.id===tied[0]);
  out.alive=false;
  room.voteChoices=null;
  room.players.forEach(p=>p.vote=null);
  const caught=out.id===room.spyId;
  const spyWins=!caught && room.players.filter(p=>p.alive).length<=2;
  if(caught || spyWins) {
    room.phase='finished';room.winner=caught?'civilian':'spy';
  } else room.phase='round_result';
  room.lastResult={type:'elimination',outId:out.id,outName:out.name,correct:caught,finished:!!(caught||spyWins),winner:room.winner};
}

const server = http.createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(req.method==='GET' && Object.hasOwn(ASSETS,url.pathname)) {
      const [filepath,mime]=ASSETS[url.pathname];
      res.writeHead(200, {'Content-Type':mime,'Cache-Control': 'no-cache','X-Content-Type-Options':'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'"});
      fs.createReadStream(path.join(__dirname,filepath)).pipe(res);return;
    }
    if(req.method==='GET' && url.pathname==='/api/state') {
      const {room}=auth({code:url.searchParams.get('code'),token:url.searchParams.get('token')});
      reply(res,200,publicState(room,url.searchParams.get('token')));return;
    }
    if(req.method==='GET' && url.pathname==='/api/events') {
      const token=url.searchParams.get('token');
      const {room}=auth({code:url.searchParams.get('code'),token});
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache,no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write(`retry: 2000\ndata: ${JSON.stringify(publicState(room,token))}\n\n`);
      const subscriber={res,token};room.subscribers.add(subscriber);
      const heartbeat=setInterval(()=>{try{res.write(': ping\n\n');}catch(_){clearInterval(heartbeat);room.subscribers.delete(subscriber);}},25000);
      res.on('close',()=>{clearInterval(heartbeat);room.subscribers.delete(subscriber);});return;
    }
    if(req.method==='GET' && url.pathname==='/health') {reply(res,200,{ok:true});return;}
    if(req.method!=='POST' || !url.pathname.startsWith('/api/')) {reply(res,404,{error:'没有找到这个页面。'});return;}
    let data='';
    for await (const chunk of req) {data+=chunk.toString('utf8');if(data.length>12000)failure('请求数据太大。',413);}
    let payload;try{payload=JSON.parse(data||'{}');}catch(_){failure('提交的数据不正确。');}
    const name = typeof payload.name==='string' ? payload.name.trim().slice(0,16) : '';
    if(url.pathname==='/api/create') {
      if(!name)failure('先输入你的昵称。');
      if(rooms.size>=1000)failure('当前房间太多，请稍后再试。',503);
      let id;do{id=code();}while(rooms.has(id));
      const token=crypto.randomBytes(24).toString('hex');
      const capacity = payload.capacity === undefined ? 5 : Number(payload.capacity);
      if(!Number.isInteger(capacity) || capacity < MIN_PLAYERS || capacity > MAX_PLAYERS)failure('房间人数必须设置为2到10人。');
      const room={code:id,capacity,players:[{id:1,name,alive:true,token,vote:null,guess:null}],hostToken:token,phase:'lobby',round:0,subscribers:new Set(),pair:null,spyId:null,isDuel:false,duelResult:null,usedPairIndices:new Set(),roundsPlayed:0,lastResult:null,voteChoices:null,winner:null,revealed:false,updatedAt:Date.now()};
      rooms.set(id,room);reply(res,200,{code:id,token});return;
    }
    if(url.pathname==='/api/join') {
      if(!name)failure('先输入你的昵称。');
      const id=String(payload.code||'').trim().toUpperCase();
      const room=rooms.get(id);
      if(!room)failure('找不到房间，请核对房间号。',404);
      if(room.phase!=='lobby')failure('游戏已经开始，不能中途加入。');
      if(room.players.length>=room.capacity)failure('房间已经满员。');
      if(room.players.some(p=>p.name.toLowerCase()===name.toLowerCase()))failure('昵称重复，换一个试试。');
      const token=crypto.randomBytes(24).toString('hex');
      const taken = new Set(room.players.map(p=>p.id));
      let idNum=1;while(taken.has(idNum))idNum++;
      room.players.push({id:idNum,name,alive:true,token,vote:null,guess:null});
      dispatch(room);reply(res,200,{code:id,token});return;
    }
    const {room,me}=auth(payload);
    if(url.pathname==='/api/start') {
      requireHost(room,me);
      if(room.phase!=='lobby' || room.players.length<MIN_PLAYERS || room.players.length>room.capacity)failure('需要至少2名玩家才能开始，且不能超过房间人数上限。');
      resetGame(room);
    } else if(url.pathname==='/api/open-vote') {
      requireHost(room,me);
      if(room.phase!=='sing')failure('现在还不能开启投票。');
      room.phase=room.isDuel?'duel_guess':'voting';room.players.forEach(p=>{p.vote=null;p.guess=null;});
    } else if(url.pathname==='/api/guess') {
      if(!room.isDuel || room.phase!=='duel_guess')failure('当前不是双人猜情景阶段。');
      if(me.guess!==null)failure('你已经提交过猜测啦。');
      const choice=Number(payload.choice);
      if(!Number.isInteger(choice) || choice<0 || choice>=me.duelChoices.length)failure('请选择一个有效的情景选项。');
      me.guess=choice;
      if(room.players.every(p=>p.guess!==null)) {
        const correctIds=room.players.filter(p=> {
          const other=room.players.find(other=>other.id!==p.id);
          const correct=other.id===room.spyId ? room.pair.spy : room.pair.common;
          return p.duelChoices[p.guess]===correct;
        }).map(p=>p.id);
        room.duelResult={correctIds, winnerId:correctIds.length===1?correctIds[0]:null, draw:correctIds.length!==1};
        room.phase='finished';room.winner='duel';
      }
    } else if(url.pathname==='/api/vote') {
      if(room.isDuel || !['voting','tie'].includes(room.phase))failure('当前不是投票阶段。');
      if(!me.alive)failure('你已被淘汰，不能参与投票。');
      if(me.vote)failure('你已经投过票啦。');
      const target=Number(payload.target);
      if(!Number.isInteger(target) || target===me.id)failure('请选择其他玩家。');
      if(!room.players.some(p=>p.id===target&&p.alive))failure('目标玩家已被淘汰。');
      if(room.voteChoices && !room.voteChoices.includes(target))failure('请在并列玩家中投票。');
      me.vote=target;
      if(room.players.filter(p=>p.alive).every(p=>p.vote!==null))voteResult(room);
    } else if(url.pathname==='/api/next') {
      requireHost(room,me);
      if(room.phase!=='round_result')failure('现在不能进入下一轮。');
      room.round++;room.phase='sing';room.lastResult=null;
    } else if(url.pathname==='/api/restart') {
      requireHost(room,me);
      if(room.phase!=='finished')failure('本局尚未结束。');
      if(room.players.length<MIN_PLAYERS || room.players.length>room.capacity)failure('需要2到房间人数上限名玩家。');
      resetGame(room);
    } else if(url.pathname==='/api/reveal') {
      requireHost(room,me);
      if(room.phase!=='finished')failure('只能在游戏结束后揭晓身份。');
      room.revealed=true;
    } else if(url.pathname==='/api/kick') {
      requireHost(room,me);
      if(room.phase!=='lobby')failure('只能在开局前移除玩家。');
      const target=Number(payload.target);
      if(target===me.id)failure('房主不能移除自己。');
      const p=room.players.find(p=>p.id===target);
      if(!p)failure('玩家不存在。');
      room.players=room.players.filter(p=>p.id!==target);
      for(const sub of [...room.subscribers])if(sub.token===p.token){sub.res.end();room.subscribers.delete(sub);}
    } else failure('未识别的操作。',404);
    dispatch(room);
    reply(res,200,{ok:true});
  } catch(err){reply(res,err.status||500,{error:err.status?err.message:'服务器遇到错误，请稍后重试。'});if(!err.status)console.error(err);}
});
setInterval(()=>{const cutoff=Date.now()-ROOM_TTL;for(const [id,r] of rooms)if(r.updatedAt<cutoff){for(const sub of r.subscribers)sub.res.end();rooms.delete(id);}},10*60*1000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`🎤 唱歌谁是卧底： http://localhost:${PORT}`));
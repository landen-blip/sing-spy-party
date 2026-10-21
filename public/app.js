'use strict';
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let session = null;
let current = null;
let events = null;
let mode = new URLSearchParams(location.search).has('room') ? 'join' : 'create';
let exposed = false;
let online = true;
let busy = false;
let toastTimer;
const STORAGE = 'sing-spy-session-v1';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const $ = selector => document.querySelector(selector);
const esc = input => String(input ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function toast(message){toastEl.textContent=message;toastEl.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastEl.classList.remove('show'),3300);}
function setSession(data){session=data;localStorage.setItem(STORAGE,JSON.stringify(session));history.replaceState(null,'',`/?room=${encodeURIComponent(session.code)}`);}
function clearSession(){localStorage.removeItem(STORAGE);session=null;current=null;exposed=false;if(events)events.close();events=null;history.replaceState(null,'','/');renderLanding();}
function savedSession(){try{return JSON.parse(localStorage.getItem(STORAGE)||'null');}catch(_){return null;}}
async function api(url,body){const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.error||'发生网络错误');return data;}
async function doAction(action,extras={},confirmText='') {
  if(busy)return;
  if(confirmText&&!window.confirm(confirmText))return;
  busy=true;
  try{await api(`/api/${action}`,{...session, ...extras});}
  catch(err){toast(err.message);}finally{busy=false;}
}
function connect(){
  if(events){events.close();events=null;}
  events=new EventSource(`/api/events?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
  events.onmessage=evt=>{
    let state;try{state=JSON.parse(evt.data);}catch(_){return;}
    online=true;
    const oldPhase=current?.phase;
    const oldRound=current?.round;
    const oldReveal=current?.reveal;
    const oldPrompt=current?.prompt;
    current=state;
    if(oldPhase!==state.phase || oldRound!==state.round || oldPrompt!==state.prompt || !!oldReveal!==!!state.reveal)exposed=false;
    renderGame();
  };
  events.onerror=()=>{online=false;if(current)updateNetworkIndicator();};
}
function updateNetworkIndicator(){const el=$('#network-status');if(el){el.className=`status${online?'':' disconnected'}`;el.textContent=online?'已实时连接':'连接中断，正在重连…';}}
function heading(eyebrow,title,description){return `<div class="section-top"><div><div class="badge">${esc(eyebrow)}</div><h1 class="page-title">${esc(title)}</h1><div class="small">${esc(description)}</div></div><div class="room-pill"><small>ROOM CODE</small><strong>${esc(current.code)}</strong></div></div>`;}
function seatGrid(showKick){return `<div class="seat-list">${Array.from({length:current.maxPlayers},(_,i)=>{
  const p=current.players.find(p=>p.id===i+1);
  if(!p)return `<div class="seat empty"><div class="avatar">＋</div><div class="name">待加入</div><div class="seat-id">${i+1}号位</div></div>`;
  const status=current.phase==='lobby'?'已就位':!p.alive?'已淘汰':['voting','tie','duel_guess'].includes(current.phase)?(p.hasVoted?(current.isDuel?'已猜测':'已投票'):(current.isDuel?'未猜测':'未投票')):'游戏中';
  return `<div class="seat ${p.alive?'':'out'}"><div class="avatar">${p.alive?'♪':'×'}</div><div class="name" title="${esc(p.name)}">${esc(p.name)}${p.id===current.me.id?' (我)':''}</div><div class="seat-id">${p.id}号玩家</div><div class="seat-meta">${esc(status)}</div>${showKick&&p.id!==current.me.id?`<button class="kick" title="移除玩家" data-action="kick" data-target="${p.id}" aria-label="移除${esc(p.name)}">×</button>`:''}</div>`;
}).join('')}</div>`;}
function secretCard(){
  if(!current.me.alive)return `<div class="secret locked"><div class="secret-label">👀 观战模式</div><p class="secret-text">你已被淘汰，请继续欣赏其他玩家的表演。</p></div>`;
  if(!current.prompt)return '';
  if(!exposed)return `<div class="secret locked"><div class="secret-label">🔒 只有你能看到的情景</div><p class="small" style="margin:13px 0 17px">确认旁边没有其他人偷看屏幕，再点开你的情景。</p><button class="btn primary" data-action="show-secret">👁️ 点击查看我的情景</button></div>`;
  return `<div class="secret"><div class="secret-label">🎭 你的秘密情景 · 请勿外传</div><div class="secret-text">「${esc(current.prompt)}」</div><div class="privacy-msg">选择一首符合这个情景的歌，不要直接念出情景哦。</div><button class="btn ghost" style="margin-top:18px" data-action="hide-secret">🔒 隐藏情景</button></div>`;
}
function copyShare(){const shareUrl=`${location.origin}/?room=${encodeURIComponent(current.code)}`;const fallback=()=>{const input=$('#share-url');if(input){input.focus();input.select();toast('请手动复制邀请链接');}};if(navigator.clipboard?.writeText)navigator.clipboard.writeText(shareUrl).then(()=>toast('邀请链接已复制！')).catch(fallback);else fallback();}
function renderLanding(){
  const initialCode=new URLSearchParams(location.search).get('room')||'';
  const options=Array.from({length:MAX_PLAYERS-MIN_PLAYERS+1},(_,i)=>i+MIN_PLAYERS).map(n=>`<option value="${n}" ${n===5?'selected':''}>${n} 人</option>`).join('');
  root.innerHTML=`<div class="landing">
    <section class="hero" aria-label="游戏介绍">
      <span class="eyebrow">VOL. 01 &nbsp; / &nbsp; MUSIC × MYSTERY</span>
      <h1>今晚，<br>谁在<span class="gradient-text">唱谎？</span></h1>
      <p class="lead">每个人都有一段秘密情景，用一首歌讲出来。听懂旋律里的暗号，找出那个与众不同的人。</p>
      <div class="hero-bottom" aria-hidden="true">
        <div class="vinyl"><span class="vinyl-center">♪</span></div>
        <div><div class="hero-side-note">DROP THE BEAT.<br>KEEP THE SECRET.<br>FIND THE SPY.</div><div class="sound-waves">${[18,35,27,48,22,42,30,55,25,39,19].map((h,i)=>`<i style="--h:${h}px;--d:${i*.09}s"></i>`).join('')}</div></div>
      </div>
    </section>
    <section class="entry" aria-label="开始游戏">
      <div class="panel">
        <div class="entry-kicker">✳ &nbsp; READY TO PLAY?</div>
        <h2 class="entry-title">下一首，轮到你。</h2>
        <p class="entry-desc">2–10 人在线开局，2 人可玩特别对唱模式。</p>
        <div class="switch" role="group" aria-label="选择进房方式"><button data-action="mode-create" type="button" aria-pressed="${mode==='create'}" class="${mode==='create'?'active':''}">创建房间</button><button data-action="mode-join" type="button" aria-pressed="${mode==='join'}" class="${mode==='join'?'active':''}">加入房间</button></div>
        <form id="entry-form">
          <div class="field"><label for="nickname">玩家昵称</label><input id="nickname" maxlength="16" required autocomplete="nickname" placeholder="给自己起个有趣的名字" /></div>
          ${mode==='join'?`<div class="field"><label for="roomcode">房间邀请码</label><input id="roomcode" maxlength="5" required autocapitalize="characters" style="text-transform:uppercase;letter-spacing:4px;font-weight:850" value="${esc(initialCode)}" placeholder="输入5位房间号" /></div>`:`<div class="field"><label for="capacity">房间人数上限</label><select id="capacity">${options}</select><div class="small" style="margin-top:7px">至少 2 人即可开局，3–10 人为经典卧底局。</div></div>`}
          <button type="submit" class="btn primary full"><span>${mode==='create'?'创建我的房间':'进入游戏房间'}</span><span class="btn-arrow" aria-hidden="true">↗</span></button>
        </form>
        <div class="entry-hint">无需注册 · 各自查看秘密情景 · 自动结算投票</div>
      </div>
      <div class="mini-info"><span>✦ 私密情景</span><span>♫ 自由选歌</span><span>◎ 实时投票</span></div>
    </section>
  </div>`;
}
function lobby(){
  const joined=current.players.length;
  const remaining=current.maxPlayers-joined;
  return `${heading('🎉 THE LOBBY','等待麦霸入场',`支持2–10人开局，当前${joined}人已进入；房主可在至少2人后随时开局。`)}
  <div class="panel">${seatGrid(current.isHost)}
  <div class="share"><div class="share-text"><div style="font-size:12px;color:#b3add3;margin-bottom:5px">🔗 发送邀请链接（还可加入${remaining}人）</div><input id="share-url" value="${esc(location.origin+'/?room='+current.code)}" readonly aria-label="邀请链接" /></div><button data-action="copy" class="btn secondary">📋 复制邀请链接</button></div>
  ${['localhost','127.0.0.1'].includes(location.hostname)?`<div class="hint" style="color:#ffd084">⚠️ 当前是 localhost 地址，其他手机无法通过这个邀请链接加入。请用终端显示的「同 Wi-Fi 手机地址」访问后建房，再复制邀请链接。</div>`:''}
  <div class="actions">${current.isHost?`<button data-action="start" class="btn primary" ${joined<MIN_PLAYERS?'disabled':''}>🚀 ${joined>=MIN_PLAYERS?`现在开局（${joined}人）`:'至少还需1人才能开始'}</button>`:`<div class="chip">⏳ 等待房主开始游戏…</div>`}</div>
  <div class="hint">目前 ${joined}/${current.maxPlayers} 人 · 房间号 <strong>${esc(current.code)}</strong>${joined===2?' · 双人局为情景互猜':''}</div></div>`;
}
function singer(){
  return `${heading(`🎼 ROUND ${current.round}`,'听歌辨身份',`第 ${current.round} 轮 · 请所有存活玩家根据自己的秘密情景选歌演唱。`)}<div class="panel spotlight"><div class="emoji">🎤</div><h2>麦克风已经就位！</h2><p>${current.isDuel?'双人特别模式：先根据自己的情景选歌演唱，再分别猜测对方的情景。':'所有人现在都可以同时看自己的情景。轮流唱歌，仔细分析谁和大家的感觉不一样。'}</p>${secretCard()}<div class="phase-line"><span class="chip">🎵 正在唱歌</span><span class="chip">🕵️ 卧底潜伏中</span><span class="chip">👥 ${current.activeCount}人存活</span></div>${current.isHost?`<div class="actions"><button class="btn primary" data-action="open-vote">${current.isDuel?'🎯 唱完了，开始互猜':'🗳️ 大家唱完了，开启投票'}</button></div>`:`<div class="hint">所有人唱完后，由房主${current.isDuel?'开启互猜':'开启投票'}。</div>`}</div><div class="panel" style="margin-top:17px">${seatGrid(false)}</div>`;
}
function vote(){
  const voted=current.players.filter(p=>p.alive&&p.hasVoted).length;
  const count=current.activeCount;
  const tie=current.phase==='tie';
  const options=current.players.filter(p=>p.alive && p.id!==current.me.id && (!current.eligible || current.eligible.includes(p.id)));
  return `${heading(`🗳️ ROUND ${current.round}`,tie?'最高票平票！':'投出你的一票',tie?'请在并列最高票的玩家中重新投票。':'所有存活玩家同时投票，投票结果由系统自动结算。')}
    <div class="panel spotlight"><div class="emoji">${tie?'⚖️':'🕵️'}</div><h2>${tie?'再选一次！':'谁的歌最可疑？'}</h2><p>请根据刚才的演唱做判断。每人只有一票，投出后不能修改。</p>
    ${current.me.alive?(!current.myVote?`<div class="question">选择你怀疑的玩家（不能投自己）</div><div class="vote-grid">${options.map(p=>`<button class="vote-btn" data-action="vote" data-target="${p.id}"><span class="vote-num">${p.id}</span><span class="vote-name">${esc(p.name)}</span><span>↗</span></button>`).join('')}</div>`:`<div class="secret locked"><div class="secret-label">✅ 已成功投票</div><p class="secret-text">等待其他玩家完成投票…</p></div>`):`<div class="chip">你已被淘汰，等待其余玩家投票</div>`}
    <div class="progress"><div class="progress-fill" style="width:${Math.round(voted/count*100)}%"></div></div><div class="small">${voted} / ${count} 人已完成投票</div>
    </div><div class="panel" style="margin-top:17px">${seatGrid(false)}</div>`;
}
function duelGuess(){
  const guessed=current.players.filter(p=>p.hasVoted).length;
  return `${heading('🎯 TWO PLAYER DUEL','猜猜对方的情景','双方各有一首属于自己的情景歌，听完后从4个选项里猜对方的情景。')}
    <div class="panel spotlight"><div class="emoji">🎧</div><h2>听懂对方的歌了吗？</h2><p>选择对方的秘密情景。双方独立作答，完成后比较谁猜对了。你的答案不会提前公开。</p>
    ${current.myGuess===null?`<div class="question">你认为对方拿到的情景是：</div><div class="duel-choices">${(current.duelChoices||[]).map((choice,index)=>`<button class="duel-choice" data-action="guess" data-choice="${index}"><span class="vote-num">${String.fromCharCode(65+index)}</span><span>${esc(choice)}</span></button>`).join('')}</div>`:`<div class="secret locked"><div class="secret-label">✅ 猜测已提交</div><p class="secret-text">等待对方选择…</p></div>`}
    <div class="progress"><div class="progress-fill" style="width:${guessed*50}%"></div></div><div class="small">${guessed} / 2 人已完成猜测</div></div>
    <div class="panel" style="margin-top:17px">${seatGrid(false)}</div>`;
}
function result(){
  const last=current.lastResult;
  const out=current.players.find(p=>p.id===last?.outId);
  return `${heading(`🎼 ROUND ${current.round}`,'本轮投票结果','票数统计完毕。未结束前不会揭露真正的卧底身份。')}<div class="panel spotlight"><div class="result-mark">🎯</div><div class="result-title">${out?esc(out.name):'一位玩家'} 被淘汰！</div><p>${last?.correct?'抓对了卧底。':'没抓对！卧底仍然潜伏在场。'}</p><p>现在还剩 <strong>${current.activeCount}</strong> 位玩家。</p><div class="actions">${current.isHost?`<button class="btn primary" data-action="next">🎤 进入下一轮唱歌</button>`:`<div class="chip">⏳ 等待房主开启下一轮</div>`}</div></div><div class="panel" style="margin-top:17px">${seatGrid(false)}</div>`;
}
function finished(){
  if(current.isDuel){
    const outcome=current.duelResult;
    const winner=current.players.find(p=>p.id===outcome?.winnerId);
    const iWon=outcome?.winnerId===current.me.id;
    return `${heading('🏁 DUEL COMPLETE','双人对唱结束','双人模式按猜中对方情景的情况决定胜负。')}
      <div class="panel spotlight"><div class="result-mark">${outcome?.draw?'🤝':iWon?'🏆':'🎶'}</div><div class="result-title">${outcome?.draw?'这局平手！':`${esc(winner?.name||'玩家')} 猜对获胜！`}</div>
      <p>${outcome?.draw?(outcome.correctIds.length===2?'双方都猜对了！':'双方都没有猜对，再来一局！'):`${esc(winner?.name||'玩家')} 猜中了对方的情景。`}</p>
      ${current.reveal?`<div class="reveal-card"><div class="question">🔓 房主已揭晓情景</div><p><b>1号玩家：</b>${esc(current.reveal.spyId===1?current.reveal.spy:current.reveal.common)}</p><p><b>2号玩家：</b>${esc(current.reveal.spyId===2?current.reveal.spy:current.reveal.common)}</p></div>`:`<p class="show-more">🔒 双方的真实情景仍然保密，如想查看须由房主主动揭晓。</p>`}
      <div class="actions">${current.isHost?`<button class="btn primary" data-action="restart">🔄 再来一局</button>${!current.reveal?`<button class="btn ghost" data-action="reveal">👁️ 揭晓情景</button>`:''}`:`<div class="chip">等待房主开启新一局…</div>`}</div></div><div class="panel" style="margin-top:17px">${seatGrid(false)}</div>`;
  }
  const civilian=current.winner==='civilian';
  return `${heading('🏁 GAME OVER','这一局结束啦','比赛已经决出胜负。默认继续隐藏卧底身份和双方情景。')}<div class="panel spotlight"><div class="result-mark">${civilian?'🏆':'🕵️'}</div><div class="result-title ${civilian?'win':'lose'}">${civilian?'平民阵营获胜！':'卧底阵营获胜！'}</div><p>${civilian?'平民们成功找出了卧底！':'卧底成功潜伏到仅剩两名玩家！'}</p>
    ${current.lastResult?.outName?`<div class="chip">本轮淘汰：${esc(current.lastResult.outName)}</div>`:''}
    ${current.reveal?`<div class="reveal-card"><div class="question">🔓 身份与情景已由房主揭晓</div><p><b>卧底：</b>${current.reveal.spyId} 号玩家 · ${esc(current.players.find(p=>p.id===current.reveal.spyId)?.name||'')}</p><p><b>平民情景：</b>${esc(current.reveal.common)}</p><p><b>卧底情景：</b>${esc(current.reveal.spy)}</p></div>`:`<p class="show-more">🔒 卧底身份及情景保持保密。如想揭晓，房主可主动选择。</p>`}
    <div class="actions">${current.isHost?`<button class="btn primary" data-action="restart">🔄 再来一局</button>${!current.reveal?`<button class="btn ghost" data-action="reveal">👁️ 揭晓身份</button>`:''}`:`<div class="chip">等待房主开启新一局…</div>`}</div></div><div class="panel" style="margin-top:17px">${seatGrid(false)}</div>`;
}
function renderGame(){if(!current)return;root.innerHTML=`<div class="game">${current.phase==='lobby'?lobby():current.phase==='sing'?singer():['voting','tie'].includes(current.phase)?vote():current.phase==='round_result'?result():current.phase==='duel_guess'?duelGuess():finished()}<div style="display:flex;justify-content:space-between;align-items:center;margin:15px 4px 0;gap:8px;flex-wrap:wrap"><span id="network-status" class="status">${online?'已实时连接':'连接中断，正在重连…'}</span><button data-action="leave-screen" class="btn ghost" style="min-height:33px;padding:5px 11px;font-size:12px">切换房间 / 返回首页</button></div></div>`;updateNetworkIndicator();}
root.addEventListener('click',async event=>{
  const control=event.target.closest('[data-action]');if(!control)return;
  const action=control.dataset.action;
  if(action==='mode-create'||action==='mode-join'){mode=action.slice(5);renderLanding();return;}
  if(action==='copy'){copyShare();return;}
  if(action==='show-secret'){exposed=true;renderGame();return;}
  if(action==='hide-secret'){exposed=false;renderGame();return;}
  if(action==='leave-screen'){if(confirm('返回首页会清除本设备的游戏身份，不能重新加入已经开局的房间。确定离开吗？'))clearSession();return;}
  if(action==='start')return doAction('start');
  if(action==='open-vote')return doAction('open-vote');
  if(action==='next')return doAction('next');
  if(action==='restart')return doAction('restart');
  if(action==='reveal')return doAction('reveal',{},'确定要向所有玩家公布卧底身份和双方的情景吗？');
  if(action==='kick')return doAction('kick',{target:Number(control.dataset.target)},'确定移除这位玩家吗？');
  if(action==='guess')return doAction('guess',{choice:Number(control.dataset.choice)},'确定选择这个情景吗？提交后不能更改。');
  if(action==='vote') {
    const p=current.players.find(p=>p.id===Number(control.dataset.target));
    return doAction('vote',{target:p.id},`确认投给 ${p.id} 号「${p.name}」吗？投票后不能更改。`);
  }
});
root.addEventListener('submit',async event=>{
  if(event.target.id!=='entry-form')return;
  event.preventDefault();
  if(busy)return;
  const name=$('#nickname').value.trim();
  const code=mode==='join'?$('#roomcode').value.trim().toUpperCase():null;
  const capacity=mode==='create'?Number($('#capacity').value):undefined;
  if(!name){toast('请先输入昵称');return;}
  if(mode==='join' && code.length!==5){toast('请输入5位房间号');return;}
  busy=true;
  const submit=$('#entry-form button[type="submit"]');submit.disabled=true;submit.textContent='正在进入…';
  try{const data=await api(mode==='create'?'/api/create':'/api/join',{name,code,capacity});setSession(data);connect();}
  catch(err){toast(err.message);submit.disabled=false;submit.textContent=mode==='create'?'🎤 创建游戏房间':'🎶 加入游戏房间';}finally{busy=false;}
});
window.addEventListener('pageshow',()=>{if(session&&!events)connect();});
(async()=>{
  const saved=savedSession();
  if(saved?.code&&saved?.token){try{const res=await fetch(`/api/state?code=${encodeURIComponent(saved.code)}&token=${encodeURIComponent(saved.token)}`);if(res.ok){setSession(saved);current=await res.json();renderGame();connect();return;}}catch(_){/* show entrance */}localStorage.removeItem(STORAGE);}
  renderLanding();
})();

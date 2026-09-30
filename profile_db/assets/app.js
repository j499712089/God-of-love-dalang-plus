/* 女生档案库 · 前端逻辑
   数据源：同目录 data/db.js（由 Agent/CLI 自动重建）
   编辑：生成待写入内容；真实落盘统一由 Agent/CLI 完成
   ------------------------------------------------------------------ */
const LS = 'nvsheng_overrides';
let FILTER = 'all';

function refreshStaticBoard(){
  render();
  return true;
}

/* ---------- 数据层 ---------- */
function overrides(){ try{ return JSON.parse(localStorage.getItem(LS)) || {}; }catch(e){ return {}; } }
function saveOv(o){ localStorage.setItem(LS, JSON.stringify(o)); }

function allProfiles(){
  const base = JSON.parse(JSON.stringify(window.PROFILES || {}));
  const ov = overrides();
  Object.keys(ov).forEach(id=>{
    if(ov[id] === null){ delete base[id]; return; }
    base[id] = Object.assign(base[id] || {}, ov[id]);
  });
  return base;
}

const W = {intent:25, speed:20, respond:20, match:15, truth:10, risk:10};
function calcInterest(p){
  const bd = p.interest_breakdown || {};
  let t = 0;
  for(const k in W) t += Math.min(Number(bd[k]) || 0, W[k]);
  const illusion = (p.inferences||[]).some(i=>/幻觉/.test((i.title||'')+(i.evidence||'')));
  if(illusion || p.verdict === '已止损') t = Math.min(t, 30);
  return t;
}

function roster(){
  const ps = allProfiles();
  return Object.values(ps).map(p=>({
    id:p.id, name:p.name, platform:p.platform, verdict:p.verdict,
    truth_level:p.truth_level || '未评', updated:p.updated || 0,
    interest: calcInterest(p)
  })).sort((a,b)=> b.interest - a.interest || b.updated - a.updated)
     .map((r,i)=>(r.rank = i+1, r));
}

/* ---------- 工具 ---------- */
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const intColor = v => v>=70 ? 'var(--push)' : v>=40 ? 'var(--watch)' : 'var(--stop)';
function ago(ts){
  if(!ts) return '—';
  const d = Math.floor((Date.now()-ts)/86400000);
  return d<=0 ? '今天' : d===1 ? '昨天' : d<30 ? d+'天前' : Math.floor(d/30)+'个月前';
}

/* ---------- 列表页 ---------- */
function setF(el){
  document.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on'); FILTER = el.dataset.f; render();
}

function render(){
  const rs = roster();
  const q = (document.getElementById('q').value||'').trim().toLowerCase();
  const ps = allProfiles();

  document.getElementById('s0').textContent = rs.length;
  document.getElementById('s1').textContent = rs.filter(r=>r.verdict==='推进中').length;
  document.getElementById('s2').textContent = rs.filter(r=>r.verdict==='观察中').length;
  document.getElementById('s3').textContent = rs.filter(r=>r.verdict==='已止损').length;

  /* 排行榜：全量，不受筛选/搜索影响 */
  document.getElementById('rankList').innerHTML = rs.length ? rs.map(r=>`
    <div class="rank-row" onclick="openDetail('${r.id}')">
      <div class="rk-no">${r.rank}</div>
      <div class="rk-name">${esc(r.name)}</div>
      <div class="rk-plat">${esc(r.platform)}</div>
      <div class="rk-bar"><div class="rk-fill" style="width:${r.interest}%;background:${intColor(r.interest)}"></div></div>
      <div class="rk-val">${r.interest}</div>
      <div class="rk-vd" style="color:${intColor(r.interest)}">${esc(r.verdict)}</div>
    </div>`).join('') : '<div style="color:var(--txt3);font-size:13px">暂无档案</div>';

  /* 卡片网格 */
  const list = rs.filter(r=>{
    if(FILTER!=='all' && r.verdict!==FILTER) return false;
    if(!q) return true;
    const p = ps[r.id] || {};
    const hay = [r.name,r.platform,r.verdict,r.truth_level,p.summary,
      JSON.stringify(p.facts||{})].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const cards = list.map(r=>{
    const p = ps[r.id] || {};
    const f = p.facts || {};
    const sub = [f['年龄'],f['职业标签']||f['职业'],r.platform].filter(Boolean).join(' · ');
    return `<div class="card" onclick="openDetail('${r.id}')">
      <div class="c-hd">
        <div class="av">${esc(r.name.slice(0,1))}</div>
        <div>
          <div class="c-name">${esc(r.name)}<span class="vd ${r.verdict}">${r.verdict}</span></div>
          <div class="c-sub">${esc(sub)}</div>
        </div>
      </div>
      <div class="c-int">
        <div class="bar"><i style="width:${r.interest}%;background:${intColor(r.interest)}"></i></div>
        <b style="color:${intColor(r.interest)}">${r.interest}</b>
      </div>
      <div class="c-meta">
        <span>#${r.rank} · 真实度 ${esc(r.truth_level)}</span>
        <span>${ago(r.updated)}</span>
      </div>
    </div>`;
  }).join('');

  const libEmpty = !(window.ROSTER || []).length;
  const emptyBlock = libEmpty ? `<div class="empty onboard">
      <div class="ob-t">档案库还是空的</div>
      <div class="ob-p">两种方式建第一张资料卡，任选其一：</div>
      <div class="ob-w"><b>方式一（推荐）· 让 AI 建</b>
        把女生的资料截图或简介发给 AI，说「用恋爱之神大浪_PLUS 分析这个女生」。
        AI 会先问你要不要建档，答「建档」后自动写进这里，并跑满真实性核验、兴趣度打分和升温计划。</div>
      <div class="ob-w"><b>方式二 · 自己建</b>
        点下方「＋ 新增档案」，填昵称和平台，先占位，之后再补内容。</div>
      <div class="ob-p ob-tip">以后每次聊天有新进展，把记录发给 AI，它会追加到该档案的互动时间线并重算分数。</div>
    </div>` : `<div class="empty">没有匹配的档案</div>`;

  document.getElementById('grid').innerHTML =
    (list.length ? cards : emptyBlock) +
    `<div class="card c-add" onclick="addProfile()"><div><div>＋</div><div>新增档案</div></div></div>`;
}

/* ---------- 增删 ---------- */
function addProfile(){
  alert('请把资料发给 Agent 建档。Agent 写入用户库并重建 data/db.js 后，刷新本页面即可看到。');
}

function delProfile(id){
  const p = allProfiles()[id];
  if(!p || !confirm(`删除「${p.name}」的档案？`)) return;
  flashHint('请让 Agent 执行 profile_cli.py delete --id '+id+'；刷新页面后显示最新数据。');
}

function rebuildHint(){
  alert('当前为静态看板模式：\n\n1. 页面字段退出输入框即自动保存到本机浏览器\n2. 页面立即回填并刷新当前卡片\n3. 关闭或刷新页面后，本机浏览器中的修改仍会保留\n4. Agent/CLI 写入源文件并 rebuild 后，清除本机覆盖即可回到源文件\n\n本页面不启动后端、不依赖端口；浏览器自动保存不等于改写 JSON 源文件。');
}

/* ---------- 就地编辑 ---------- */
function patch(id, path, val){
  const ov = overrides();
  const cur = ov[id] ? JSON.parse(JSON.stringify(ov[id])) : {};
  const base = (window.PROFILES||{})[id] || {};
  let tgt = cur, ref = base, keys = path.split('.');
  keys.forEach((k,i)=>{
    if(i === keys.length-1){ tgt[k] = val; return; }
    if(tgt[k] == null) tgt[k] = (ref && typeof ref[k]==='object') ? JSON.parse(JSON.stringify(ref[k])) : {};
    tgt = tgt[k]; ref = ref ? ref[k] : null;
  });
  cur.id = id; cur.updated = Date.now();
  ov[id] = Object.assign(ov[id]||{}, cur); saveOv(ov);
}

/* 合并 localStorage 覆盖 + 源 profile → 生成 patch JSON（深合并，未改字段不输出） */
function getMergedProfile(id){
  const src = (window.PROFILES||{})[id] || {};
  const ov = overrides()[id] || {};
  return deepMerge(JSON.parse(JSON.stringify(src)), ov);
}
function deepMerge(a,b){
  if(Array.isArray(b)) return JSON.parse(JSON.stringify(b));
  if(b && typeof b==='object'){
    const out = JSON.parse(JSON.stringify(a||{}));
    for(const k of Object.keys(b)){ if(k==='id'||k==='updated'){out[k]=b[k];continue;} out[k]=deepMerge(out[k],b[k]); }
    return out;
  }
  return b;
}
function exportPatch(id){
  const merged = getMergedProfile(id);
  const text = JSON.stringify(merged, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const filename = `patch-${id}-${stamp}.json`;
  // 下载
  const blob = new Blob([text], {type:'application/json;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  // 复制到剪贴板（异步）
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=>{
      flashHint('✓ 已下载 '+filename+'，内容已复制到剪贴板（直接粘给 agent 或用 CLI patch）');
    }).catch(()=>flashHint('✓ 已下载 '+filename+'（剪贴板复制失败，请手动用 CLI）'));
  } else {
    flashHint('✓ 已下载 '+filename+'（请用 CLI：python scripts/profile_cli.py patch --id '+id+' --file '+filename+'）');
  }
}
function flashHint(msg){
  let h = document.getElementById('hintBar');
  if(!h){ h=document.createElement('div'); h.id='hintBar'; h.style.cssText='position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#5a3b1c;color:#ffd9a0;padding:10px 18px;border-radius:8px;z-index:9999;box-shadow:0 4px 18px rgba(0,0,0,.5);font-size:13px;z-index=9999'; document.body.appendChild(h); }
  h.textContent = msg; h.style.display='block';
  clearTimeout(h._t); h._t = setTimeout(()=>{ h.style.display='none'; }, 4500);
}
function clearEdits(id){
  const ov = overrides(); delete ov[id]; saveOv(ov); render(); renderDetail(id);
  flashHint('✓ 已清空本机编辑，恢复源文件显示');
}

function edit(el, id, path){
  const old = el.textContent.trim();
  el.contentEditable = 'true'; el.classList.add('editing'); el.focus();
  const done = async save=>{
    el.contentEditable='false'; el.classList.remove('editing');
    const v = el.textContent.trim();
    if(save && v !== old){
      patch(id, path, v);
      saveOv(overrides());
      flashHint('✓ 已自动保存到本机浏览器，刷新页面后仍会保留。');
      renderDetail(id); render();
    } else el.textContent = old;
  };
  el.onblur = ()=>done(true);
  el.onkeydown = e=>{
    if(e.key==='Enter'){ e.preventDefault(); el.blur(); }
    if(e.key==='Escape'){ el.textContent = old; el.blur(); }
  };
}
/* ---------- 详情页 ---------- */
function openDetail(id){
  document.getElementById('listPage').classList.add('hide');
  document.getElementById('detailPage').classList.remove('hide');
  renderDetail(id); window.scrollTo(0,0);
}
function backToList(){
  document.getElementById('detailPage').classList.add('hide');
  document.getElementById('listPage').classList.remove('hide');
  render(); window.scrollTo(0,0);
}

const CONF_CLR = {'高':'var(--push)','中':'var(--watch)','低':'var(--stop)','信息不足':'var(--txt3)'};
const LV_CLR = {'通过':'var(--push)','待验':'var(--watch)','轻微存疑':'var(--watch)','不通过':'var(--stop)'};

function sect(no, title, body, note){
  return `<div class="sect">
    <div class="s-hd"><span class="s-no">${no}</span><h3>${title}</h3></div>
    ${body}${note?`<div class="s-note">${note}</div>`:''}</div>`;
}
function kvRows(id, obj, base){
  const ks = Object.keys(obj||{});
  if(!ks.length) return '<div class="none">暂无内容，点击右上「＋ 字段」录入</div>';
  return `<table class="kv">${ks.map(k=>`<tr>
    <th>${esc(k)}</th>
    <td class="ed" onclick="edit(this,'${id}','${base}.${k}')">${esc(obj[k])}</td>
  </tr>`).join('')}</table>`;
}

function renderDetail(id){
  const p = allProfiles()[id];
  if(!p){ backToList(); return; }
  const iv = calcInterest(p), bd = p.interest_breakdown || {};
  const rk = roster().find(r=>r.id===id) || {rank:'—'};

  const bdRows = Object.keys(W).map(k=>{
    const label = {intent:'婚恋意愿',speed:'推进速度',respond:'响应质量',
      match:'匹配契合',truth:'真实度',risk:'风险余量'}[k];
    const v = Math.min(Number(bd[k])||0, W[k]);
    return `<div class="bd-row">
      <span class="bd-l">${label}</span>
      <div class="bd-bar"><i style="width:${v/W[k]*100}%;background:${v/W[k]>=.6?'var(--push)':v/W[k]>=.3?'var(--watch)':'var(--stop)'}"></i></div>
      <span class="bd-v ed" onclick="edit(this,'${id}','interest_breakdown.${k}')">${v}</span>
      <span class="bd-c">/${W[k]}</span>
    </div>`;
  }).join('');

  const photos = (p.photos||[]).length ? `<table class="tb">
    <thead><tr><th style="width:38px">#</th><th style="width:32%">内容</th><th>解码</th></tr></thead>
    <tbody>${p.photos.map((x,i)=>`<tr><td class="dim">${x.n||i+1}</td>
      <td class="ed" onclick="edit(this,'${id}','photos.${i}.content')">${esc(x.content)}</td>
      <td class="ed" onclick="edit(this,'${id}','photos.${i}.decode')">${esc(x.decode)}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="none">暂无照片解码</div>';

  const tc = (p.truth_check||[]).length ? `<table class="tb">
    <thead><tr><th style="width:110px">维度</th><th>检查结果</th><th style="width:78px">判定</th></tr></thead>
    <tbody>${p.truth_check.map((x,i)=>`<tr>
      <td class="dim">${esc(x.dim)}</td>
      <td class="ed" onclick="edit(this,'${id}','truth_check.${i}.result')">${esc(x.result)}</td>
      <td style="color:${LV_CLR[x.level]||'var(--txt2)'};font-weight:600;font-size:12.5px">${esc(x.level)}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="none">暂无核验记录</div>';

  const inf = (p.inferences||[]).length ? p.inferences.map((x,i)=>`
    <div class="inf">
      <div class="inf-hd">
        <b class="ed" onclick="edit(this,'${id}','inferences.${i}.title')">${esc(x.title)}</b>
        <span class="conf" style="color:${CONF_CLR[x.confidence]||'var(--txt3)'};
          border-color:${CONF_CLR[x.confidence]||'var(--txt3)'}">${esc(x.confidence)}置信</span>
      </div>
      <div class="inf-l"><em>证据链</em><span class="ed" onclick="edit(this,'${id}','inferences.${i}.evidence')">${esc(x.evidence)}</span></div>
      <div class="inf-l"><em>两种解释</em><span>${(x.readings||[]).map(r=>`<i>${esc(r)}</i>`).join('')}</span></div>
      <div class="inf-l means"><em>对你意味着</em><span class="ed" onclick="edit(this,'${id}','inferences.${i}.means')">${esc(x.means)}</span></div>
    </div>`).join('') : '<div class="none">暂无推断</div>';

  const pos = p.position || {};
  const posBox = `<div class="two">
    <div class="pcol ok"><h4>机会</h4>${(pos.chance||[]).length
      ? `<ul>${pos.chance.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`
      : '<div class="none">无</div>'}</div>
    <div class="pcol bad"><h4>风险</h4>${(pos.risk||[]).length
      ? `<ul>${pos.risk.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`
      : '<div class="none">无</div>'}</div></div>`;

  const pl = p.plan || {};
  const planBox = `
    <div class="pl-stage"><em>阶段定位</em><span class="ed" onclick="edit(this,'${id}','plan.stage')">${esc(pl.stage)||'—'}</span></div>
    ${pl.opener?`<div class="opener"><div class="op-tag">破冰消息</div>
      <div class="op-txt ed" onclick="edit(this,'${id}','plan.opener')">${esc(pl.opener)}</div>
      ${(pl.opener_why||[]).length?`<ul class="why">${pl.opener_why.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}
    </div>`:''}
    ${(pl.rounds||[]).length?`<table class="tb"><thead><tr><th style="width:42px">轮</th>
      <th style="width:30%">目标</th><th>关键话</th></tr></thead><tbody>
      ${pl.rounds.map((r,i)=>`<tr><td class="dim">${r.n||i+1}</td>
        <td>${esc(r.goal)}</td>
        <td class="ed" onclick="edit(this,'${id}','plan.rounds.${i}.line')">${esc(r.line)}</td></tr>`).join('')}
      </tbody></table>`:''}
    <div class="two" style="margin-top:14px">
      <div class="pcol"><h4>邀约纪律</h4>${(pl.invite_rules||[]).length
        ?`<ul>${pl.invite_rules.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:'<div class="none">无</div>'}</div>
      <div class="pcol bad"><h4>降速 / 止损</h4>${(pl.stop_rules||[]).length
        ?`<ul>${pl.stop_rules.map(s=>`<li><b>${esc(s.signal)}</b> → ${esc(s.action)}</li>`).join('')}</ul>`
        :'<div class="none">无</div>'}</div>
    </div>`;

  const tl = (p.timeline||[]).length ? `<div class="tl">${p.timeline.map(t=>`
    <div class="tl-i"><div class="tl-d"></div>
      <div class="tl-t">${esc(t.t)}</div>
      <div class="tl-w ${t.who==='她'?'her':'me'}">${esc(t.who)}</div>
      <div class="tl-x ed">${esc(t.text)}</div>
      <div class="tl-g">${esc(t.gap)}</div></div>`).join('')}</div>`
    : '<div class="none">暂无互动记录 — 公域阶段尚未破冰</div>';

  const gaps = (p.gaps||[]).length ? `<div class="gaps"><h4>⚠ 需主人确认的变量（缺失则不下结论）</h4>
    <ol>${p.gaps.map(g=>`<li>${esc(g)}</li>`).join('')}</ol></div>` : '';

  document.getElementById('detailPage').innerHTML = `
  <div class="d-top">
    <button class="btn" onclick="backToList()">← 返回列表</button>
    <div style="flex:1"></div>
    <button class="btn" onclick="rebuildHint()">📋 数据写入说明</button>
    <button class="btn" onclick="clearEdits('${id}')">恢复原值</button>
    <button class="btn" onclick="delProfile('${id}')" style="color:var(--stop)">删除档案</button>
  </div>
  <div style="background:rgba(212,166,86,.08);border:1px solid rgba(212,166,86,.25);border-radius:8px;padding:8px 12px;margin:8px 0;font-size:12px;color:var(--gold);line-height:1.5" id="libStatus">
    静态看板：数据来自本目录 data/db.js；Agent 写入并重建后刷新页面。
  </div>

  <div class="hero">
    <div class="av lg">${esc(p.name.slice(0,1))}</div>
    <div class="hero-m">
      <h1 class="ed" onclick="edit(this,'${id}','name')">${esc(p.name)}</h1>
      <div class="hero-s">
        <span class="vd ${p.verdict}">${esc(p.verdict)}</span>
        <span>排名 #${rk.rank}</span><span>·</span>
        <span class="ed" onclick="edit(this,'${id}','platform')">${esc(p.platform)}</span><span>·</span>
        <span>真实度 <b class="ed" onclick="edit(this,'${id}','truth_level')">${esc(p.truth_level)}</b></span><span>·</span>
        <span>更新 ${ago(p.updated)}</span>
      </div>
    </div>
    <div class="hero-i">
      <div class="hi-v" style="color:${intColor(iv)}">${iv}</div>
      <div class="hi-l">兴趣度</div>
    </div>
  </div>

  ${p.summary?`<div class="summary"><em>一句话总结</em>
    <span class="ed" onclick="edit(this,'${id}','summary')">${esc(p.summary)}</span></div>`:''}
  ${gaps}

  ${sect(1,'资料档案 · 事实层', kvRows(id, p.facts, 'facts'))}
  ${sect(2,'兴趣度分解', `<div class="bd">${bdRows}</div>`,
    '总分由六项相加得出，命中「社交平台幻觉型」或判定已止损时上限锁 30 分。改动后刷新即重排名。')}
  ${sect(3,'照片形象解码', photos)}
  ${sect(4,'真实性五维核验', tc, p.truth_note ? '<b>评级依据：</b>'+esc(p.truth_note) : '')}
  ${sect(5,'没写在资料里的判断', inf,
    '每条必须四件套：证据链 + 置信度 + 至少两种解释 + 对你意味着。证据少于 2 项时置信度只能标「信息不足」。')}
  ${sect(6,'关系定位 · 机会与风险', posBox)}
  ${sect(7,'下一步方案', planBox, pl.funnel_note ? '<b>漏斗纪律：</b>'+esc(pl.funnel_note) : '')}
  ${sect(8,'互动时间线', tl,
    '时间间隔硬门：间隔权重高于话术内容。间隔未知时禁止对兴趣度下结论。')}
  `;
}

/* ---------- 启动 ---------- */
refreshStaticBoard();


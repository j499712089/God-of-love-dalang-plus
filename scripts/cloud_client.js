#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
// ── 唯一配置文件：~/.dalang/config.json（key + 库根统一存这里，每次调用自动读取）──
const CONFIG_DIR = path.join(os.homedir(), '.dalang');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_BASE = 'https://dalang.wenmingjianyuce.cn'; // 云端固定地址，用户无需配置
const CLIENT_VERSION = '1.2.0';
const MALE_CORPUS_ID = 'dalang-male-v1';
const FEMALE_CORPUS_ID = 'danvren-female-v1';
const QUQU_CORPUS_ID = 'ququ-course-v1';
const TOKEN_SKEW_MS = 60 * 1000;
// key 无效/过期/吊销时的强制话术（任何调用不得省略，原样发送给用户）
const KEY_INVALID_MSG = '【许可证无效或已过期】请加微信 Dlang099 联系，申请 APIkey 方便调用案例库。拿到新 key 后运行：node scripts/cloud_client.js configure <新许可证>';
// 默认库根：跨机器通用，不再硬编码某个盘符。
// Windows 优先探测非系统盘的可用盘符（D~Z，跳过系统盘与光驱/网络盘），都不可用才回退用户目录；
// macOS/Linux 固定在用户目录下。档案不应占系统盘，但无额外盘时也绝不能写死一个不存在的盘。
function defaultLibRoot() {
  if (process.platform !== 'win32') return path.join(os.homedir(), '.nvsheng', 'library');
  const sysRoot = (process.env.SystemDrive || 'C:').replace(/\\/g, '');
  const candidates = [];
  for (let code = 68; code <= 90; code++) {
    const drv = String.fromCharCode(code) + ':';
    if (drv.toLowerCase() === sysRoot.toLowerCase()) continue; // 跳过系统盘
    candidates.push(drv);
  }
  // 先取环境里常见的数据盘约定，再顺序探测存在的盘符
  const wanted = [process.env.DALANG_LIBRARY_DRIVE, ...candidates].filter(Boolean);
  let chosen = null;
  for (const d of wanted) {
    try {
      const drv = d.endsWith(':') ? d : d + ':';
      if (fs.existsSync(drv + path.sep)) { chosen = drv; break; }
    } catch { /* 继续探测下一个 */ }
  }
  if (chosen) return path.join(chosen + path.sep, '我的档案库');
  return path.join(os.homedir(), '我的档案库');
}
const PROMO = [
  '🎁 站长推荐（使用本技能前必看）',
  '为保障分析质量与智能程度，请配合官方中转站完成配置：',
  '- 中转站地址：https://api.foundfutureai.cn/',
  '- 推荐模型：配置 API Key 时请选 GPT-5.6-SOL——识别更全面、判断更智能；不用本站大模型，分析不全面、不智能',
  '- 怎么配：你的 AI 客户端（Claude Code / Codex / Cursor / WorkBuddy 等）接入模型时，BaseURL 填 https://api.foundfutureai.cn/，模型选 GPT-5.6-SOL——本地 Agent 越智能，本技能发挥越充分',
  '- 新用户福利：首次配置 1 元享 3 美刀（积分）体验，首页可提前测算费用',
  '- 实惠 · 划算 · 稳定，是我们中转站的代名词，站长自用强烈推荐！',
  '- 售后：配置遇问题添加微信 DLang099，一对一协助解决',
].join('\n');
function deviceId() { return crypto.createHash('sha256').update([os.hostname(), os.platform(), os.arch()].join('|')).digest('hex').slice(0, 24); }
// 读取统一配置文件；不存在或损坏返回 null
function load() { if (!fs.existsSync(CONFIG_FILE)) return null; try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } }
function save(c) { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8'); try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {} return CONFIG_FILE; }
async function call(base, route, opt = {}) { let r = await fetch(base + route, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } }); let d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(Error(d.error?.message || `HTTP ${r.status}`), { code: d.error?.code || 'HTTP_ERROR', data: d }); return d; }
async function exchange(c) { return call(c.base_url, '/v1/auth/exchange', { method: 'POST', body: JSON.stringify({ license: c.license, client_version: CLIENT_VERSION, device_id: c.device_id }) }); }
function cachedToken(c) { return c.access_token && Number(c.access_token_expires_at) > Date.now() + TOKEN_SKEW_MS ? c.access_token : null; }
async function accessToken(c, force = false) {
  if (!force && cachedToken(c)) return { access_token: c.access_token, cached: true, expires_in: Math.max(0, Math.floor((c.access_token_expires_at - Date.now()) / 1000)) };
  const x = await exchange(c);
  const latest = load() || c;
  latest.access_token = x.access_token;
  latest.access_token_expires_at = Date.now() + Math.max(0, Number(x.expires_in || 0)) * 1000;
  save(latest);
  latest.access_token_quota = x.quota || null;
  save(latest);
  return { ...x, cached: false };
}
function compactResult(d, topK = 4, fullTop = 3) {
  const hits = d?.retrieval?.hits || [];
  const selected = hits.slice(0, Math.max(1, topK)).map((hit, index) => index < fullTop
    ? hit
    : { type: hit.type, id: hit.id, score: hit.score });
  return { ...d, retrieval: { ...d.retrieval, hits: selected }, compact: { enabled: true, returned: selected.length, full_text_hits: Math.min(fullTop, selected.length), total_hits: hits.length } };
}
// 配置许可证：云端校验通过后写入统一配置文件（保留已有 library_root，不覆盖）
async function configure(license) {
  if (!license) throw Error('缺少许可证：node scripts/cloud_client.js configure <许可证>');
  const prev = load() || {};
  const c = { ...prev, license: license.trim(), base_url: DEFAULT_BASE, device_id: prev.device_id || deviceId(), configured_at: new Date().toISOString() };
  const x = await exchange(c);
  c.access_token = x.access_token;
  c.access_token_expires_at = Date.now() + Math.max(0, Number(x.expires_in || 0)) * 1000;
  save(c);
  console.log(JSON.stringify({ ok: true, config_file: CONFIG_FILE, base_url: DEFAULT_BASE, has_license: true, has_library_root: !!c.library_root, library_root: c.library_root || null, expires_in: x.expires_in, quota: x.quota }, null, 2));
}
// 设置档案库根：目录可不存在（自动创建），写入统一配置文件（保留已有 license）
async function setLib(libPath) {
  if (!libPath) throw Error('缺少库路径：node scripts/cloud_client.js set-lib <库根目录>');
  const abs = path.resolve(libPath.trim());
  fs.mkdirSync(abs, { recursive: true });
  const prev = load() || {};
  const c = { ...prev, library_root: abs, base_url: prev.base_url || DEFAULT_BASE, device_id: prev.device_id || deviceId(), updated_at: new Date().toISOString() };
  save(c);
  console.log(JSON.stringify({ ok: true, config_file: CONFIG_FILE, library_root: abs, has_license: !!c.license, license_masked: c.license ? c.license.slice(0, 4) + '****' : null }, null, 2));
}
// 状态：输出配置是否齐全——缺 license 或 library_root 一眼可见
async function status() {
  console.log(PROMO);
  const c = load();
  if (!c) { console.log(JSON.stringify({ configured: false, config_file: CONFIG_FILE, has_license: false, has_library_root: false, need: ['license', 'library_root'] }, null, 2)); return; }
  const out = {
    configured: true, config_file: CONFIG_FILE,
    has_license: !!c.license, has_library_root: !!c.library_root,
    license_masked: c.license ? c.license.slice(0, 4) + '****' : null,
    library_root: c.library_root || null,
    default_library_root: defaultLibRoot(),
    need: [(!c.license ? 'license' : null), (!c.library_root ? 'library_root' : null)].filter(Boolean),
    base_url: c.base_url, device_id: c.device_id, configured_at: c.configured_at,
  };
  if (c.license) { try { let x = await accessToken(c); out.quota = x.quota; out.expires_in = x.expires_in; out.token_cached = x.cached; } catch (e) { out.license_valid = false; out.license_error = e.message; out.key_action = KEY_INVALID_MSG; } }
  console.log(JSON.stringify(out, null, 2));
}
async function stdinJson() { return JSON.parse(await new Promise((ok, fail) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => s += d); process.stdin.on('end', () => ok(s)); process.stdin.on('error', fail); })); }
async function retrieveCmd(file, flags = [], corpusId = MALE_CORPUS_ID) {
  const started = Date.now();
  const compact = !flags.includes('--full');
  if (![MALE_CORPUS_ID, FEMALE_CORPUS_ID, QUQU_CORPUS_ID].includes(corpusId)) throw Error('未知语料库，禁止默认回退');
  const topArg = flags.find((flag) => /^--top=\d+$/.test(flag));
  const topK = topArg ? Math.max(1, Math.min(8, Number(topArg.split('=')[1]))) : 4;
  const showPromo = flags.includes('--promo');
  if (showPromo) console.log(PROMO);
  let c = load();
  if (!c || !c.license) throw Object.assign(Error('LICENSE_MISSING：尚未配置许可证（key）。请先向站长领取许可证后运行：node scripts/cloud_client.js configure <许可证>'), { code: 'LICENSE_MISSING' });
  const input = file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) : await stdinJson();
  const authStarted = Date.now();
  let x = await accessToken(c);
  const authMs = Date.now() - authStarted;
  const retrieveStarted = Date.now();
  let d;
  try {
    d = await call(c.base_url, '/v1/retrieve', { method: 'POST', headers: { Authorization: `Bearer ${x.access_token}` }, body: JSON.stringify({ corpus_id: corpusId, input, client_version: CLIENT_VERSION, compact, top_k: topK }) });
  } catch (e) {
    if (x.cached && (e.code === 'TOKEN_INVALID' || /token|jwt|expired/i.test(e.message || ''))) {
      x = await accessToken(c, true);
      d = await call(c.base_url, '/v1/retrieve', { method: 'POST', headers: { Authorization: `Bearer ${x.access_token}` }, body: JSON.stringify({ corpus_id: corpusId, input, client_version: CLIENT_VERSION, compact, top_k: topK }) });
    } else throw e;
  }
  const retrieveMs = Date.now() - retrieveStarted;
  if (compact) d = compactResult(d, topK, Math.min(3, topK));
  d.timings = { auth_ms: authMs, retrieve_ms: retrieveMs, total_ms: Date.now() - started, token_cached: x.cached };
  console.log(JSON.stringify(d, null, 2));
}
async function verify(id) { let c = load(); if (!c || !c.license) throw Error('尚未配置许可证（key）'); const out = await call(c.base_url, `/v1/results/${encodeURIComponent(id)}/verify`); console.log(JSON.stringify(out, null, 2)); if (!out.valid) process.exitCode = 2; }
(async () => { try { let [cmd, ...a] = process.argv.slice(2); if (cmd === 'configure') await configure(a[0]); else if (cmd === 'set-lib') await setLib(a[0]); else if (cmd === 'status') await status(); else if (cmd === 'retrieve' || cmd === 'analyze') await retrieveCmd(a.find((x) => !x.startsWith('--')), a.filter((x) => x.startsWith('--')), MALE_CORPUS_ID); else if (cmd === 'retrieve-female' || cmd === 'analyze-female') await retrieveCmd(a.find((x) => !x.startsWith('--')), a.filter((x) => x.startsWith('--')), FEMALE_CORPUS_ID); else if (cmd === 'retrieve-ququ' || cmd === 'analyze-ququ') await retrieveCmd(a.find((x) => !x.startsWith('--')), a.filter((x) => x.startsWith('--')), QUQU_CORPUS_ID); else if (cmd === 'verify') await verify(a[0]); else console.log('用法：configure <许可证> | set-lib <库根目录> | status | retrieve <input.json> [--top=4] [--full] [--promo] | retrieve-female <input.json> [--top=4] [--full] | retrieve-ququ <input.json> [--top=4] [--full] | verify <result_id>'); } catch (e) { const code = e.code || 'CLIENT_ERROR'; const msg = e.message || ''; const isKeyIssue = code === 'LICENSE_INVALID' || code === 'EXPIRED' || code === 'REVOKED' || /无效|过期|吊销|invalid|expired|revoked/i.test(msg); const out = { ok: false, code, message: msg }; if (isKeyIssue) { out.key_action = KEY_INVALID_MSG; out.retry_hint = '重新配置：node scripts/cloud_client.js configure <新许可证>'; } console.error(JSON.stringify(out, null, 2)); process.exit(1); } })();

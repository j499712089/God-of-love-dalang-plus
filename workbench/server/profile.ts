import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYS_PYTHON, PROFILE_DB_DIR } from "./paths";

/** 递归复制目录（兼容旧版 @types/node，不依赖 cpSync）。 */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

/**
 * 多用户 SaaS 隔离：每个用户（userId）的档案库落在 profile_db/<userId>/，
 * 机制与单机完全一致——profile_cli.py 从自身路径推导库根，因此把 scripts
 * 目录整体复制到用户目录即可实现目录隔离，且不改动 CLI 逻辑。
 * 未传 userId 时回退到共享库 profile_db/data（兼容单机历史数据 / 健康检查）。
 */
const MASTER_SCRIPTS = join(PROFILE_DB_DIR, "scripts");
const SHARED_DATA_DIR = join(PROFILE_DB_DIR, "data");
const SHARED_PROFILES_DIR = join(SHARED_DATA_DIR, "profiles");

/** 校验 userId 合法性，禁止路径穿越。 */
function assertUserId(userId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId))
    throw new Error("非法 userId，拒绝访问档案库");
}

/** 只计算路径，不做任何 bootstrap（读路径用；主脚本缺失也不影响读）。 */
function userDirs(userId: string): { cli: string; dataDir: string; profilesDir: string } {
  assertUserId(userId);
  const base = join(PROFILE_DB_DIR, userId);
  return {
    cli: join(base, "scripts", "profile_cli.py"),
    dataDir: join(base, "data"),
    profilesDir: join(base, "data", "profiles"),
  };
}

/**
 * 返回该用户的 CLI / 数据目录，必要时复制 scripts 并建目录（写路径用）。
 * 主脚本缺失时抛清晰错误，不再留下半截空目录（2026-09-25 空白页根因：copyDir
 * 在 mkdir 之后 readdirSync 抛 ENOENT，导致 /api/profile/list 500）。
 */
function userScope(userId: string): { cli: string; dataDir: string; profilesDir: string } {
  const scope = userDirs(userId);
  if (!existsSync(scope.cli)) {
    const masterCli = join(MASTER_SCRIPTS, "profile_cli.py");
    if (!existsSync(masterCli)) {
      throw new Error("档案库主脚本缺失（profile_db/scripts/profile_cli.py），无法执行写操作");
    }
    mkdirSync(join(PROFILE_DB_DIR, userId, "scripts"), { recursive: true });
    copyDir(MASTER_SCRIPTS, join(PROFILE_DB_DIR, userId, "scripts"));
    mkdirSync(scope.profilesDir, { recursive: true });
  }
  return scope;
}

function run(args: string[], userId?: string): string {
  const cli = userId ? userScope(userId).cli : join(SHARED_DATA_DIR, "..", "scripts", "profile_cli.py");
  try {
    return execFileSync(SYS_PYTHON, [cli, ...args], {
      encoding: "utf-8",
      timeout: 60000,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = (err.stdout || err.stderr || err.message || "").toString();
    throw new Error(`档案操作失败：${detail.trim().slice(0, 500)}`);
  }
}

// ---------- 读（直接读 JSON 文件，快） ----------
export function listProfiles(userId?: string): { updated: number; roster: unknown[] } {
  const dataDir = userId ? userScope(userId).dataDir : SHARED_DATA_DIR;
  const idx = join(dataDir, "index.json");
  if (!existsSync(idx)) return { updated: 0, roster: [] };
  const data = JSON.parse(readFileSync(idx, "utf-8"));
  return { updated: data.updated ?? 0, roster: data.roster ?? [] };
}

/**
 * 按名字匹配资料卡：全等 > 互相包含（昵称/备注名匹配）。
 * 2026-09-25 隔离加固：包含匹配要求唯一命中——多个候选时返回 null，
 * 宁可不绑也不能把两个窗口串到同一张卡（跨窗口污染分析）。
 */
export function matchProfile(name: string, userId?: string): string | null {
  const q = name.trim();
  if (!q) return null;
  const roster = listProfiles(userId).roster as { id: string; name: string }[];
  const norm = (s: string) => s.trim().toLowerCase();
  const exact = roster.find((r) => norm(r.name) === norm(q));
  if (exact) return exact.id;
  const fuzzy = roster.filter(
    (r) =>
      norm(r.name).includes(norm(q)) || norm(q).includes(norm(r.name)),
  );
  return fuzzy.length === 1 ? fuzzy[0].id : null;
}

// ---------- 跨平台查重（2026-09-24：同一个女生在牵手/微信等多平台，建档前先查重） ----------

export type ProfileMatchCandidate = {
  id: string;
  name: string;
  platform: string;
  verdict: string;
  /** 0~1，≥0.3 才返回；名字全等=0.5，年龄相等+0.2，同城+0.15，职业+0.1，兴趣+0.05 */
  score: number;
  reasons: string[];
};

/** 把档案的 facts 归一化成 [item, value] 条目（兼容数组与对象两种历史格式）。 */
function factEntries(facts: unknown): [string, string][] {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const out: [string, string][] = [];
  if (Array.isArray(facts)) {
    for (const f of facts as { item?: string; value?: string }[]) {
      if (f && f.item) out.push([norm(f.item), norm(f.value)]);
    }
  } else if (facts && typeof facts === "object") {
    for (const [k, v] of Object.entries(facts as Record<string, unknown>)) {
      out.push([norm(k), norm(String(v))]);
    }
  }
  return out;
}

/**
 * 跨平台查重：用识别出的资料字段对档案库全量打分，找「可能是同一个人」的已有档案。
 * 名字权重最高；年龄/城市/职业/兴趣做加分。返回按分数排序的前 3 个候选（≥0.3 才算）。
 */
export function findProfileMatches(input: {
  nickname?: string;
  age?: string;
  city?: string;
  occupation?: string;
  interests?: string[];
}, userId?: string): ProfileMatchCandidate[] {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const qName = norm(input.nickname);
  const qAge = parseInt(String(input.age ?? ""), 10);
  const qCity = norm(input.city);
  const qOcc = norm(input.occupation);
  const qInterests = (input.interests ?? []).map(norm).filter(Boolean);

  const roster = listProfiles(userId).roster as {
    id: string;
    name: string;
    platform?: string;
    verdict?: string;
  }[];
  const out: ProfileMatchCandidate[] = [];
  for (const r of roster) {
    const p = getProfile(r.id, userId) as Record<string, unknown> | null;
    if (!p) continue;
    let score = 0;
    const reasons: string[] = [];

    // 名字（最强信号）
    const name = norm(p.name);
    if (qName && name) {
      if (name === qName) {
        score += 0.5;
        reasons.push("昵称相同");
      } else if (name.includes(qName) || qName.includes(name)) {
        score += 0.35;
        reasons.push("昵称相近");
      }
    }

    const entries = factEntries(p.facts);
    const factVal = (key: string) =>
      entries.filter(([k]) => k.includes(key)).map(([, v]) => v);

    // 年龄
    const ages = factVal("年龄")
      .map((v) => parseInt(v, 10))
      .filter((n) => !Number.isNaN(n));
    if (!Number.isNaN(qAge) && ages.length) {
      const diff = Math.min(...ages.map((a) => Math.abs(a - qAge)));
      if (diff === 0) {
        score += 0.2;
        reasons.push("年龄相符");
      } else if (diff <= 2) {
        score += 0.1;
        reasons.push("年龄接近");
      }
    }

    // 城市
    if (
      qCity &&
      factVal("城市").some((v) => v && (v.includes(qCity) || qCity.includes(v)))
    ) {
      score += 0.15;
      reasons.push("同城");
    }

    // 职业
    if (
      qOcc &&
      factVal("职业").some((v) => v && (v.includes(qOcc) || qOcc.includes(v)))
    ) {
      score += 0.1;
      reasons.push("职业相符");
    }

    // 兴趣
    if (qInterests.length) {
      const hers = factVal("兴趣").join("、");
      if (hers && qInterests.some((t) => t && hers.includes(t))) {
        score += 0.05;
        reasons.push("兴趣重合");
      }
    }

    if (score >= 0.3) {
      out.push({
        id: r.id,
        name: String(p.name ?? r.name ?? r.id),
        platform: String(p.platform ?? r.platform ?? "?"),
        verdict: String(p.verdict ?? r.verdict ?? ""),
        score: Math.round(score * 100) / 100,
        reasons,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 3);
}

/** 资料卡压缩摘要：给分析大脑和对话 agent 注入用（控制 token 体积）。 */
export function profileSummary(id: string, userId?: string): string | null {
  // 🔴 2026-09-27 修复：必须带 userId 读用户自己的库——原来漏传导致所有
  // 用户都去读共享库 profile_db/data/profiles/，永远返回 null：① /api/chat
  // 对已绑卡窗口 404「资料卡不存在」（快捷提问全挂）；② 分析线注入的
  // 资料卡摘要一直为空（模型"不看资料就分析"的底层真凶）。
  const raw = getProfile(id, userId);
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(
    `资料卡：${p.name ?? id}（平台:${p.platform ?? "?"}｜结论:${p.verdict ?? "?"}｜兴趣度:${p.interest ?? "?"}｜真实性:${p.truth_level ?? "?"}）`,
  );
  const facts = Array.isArray(p.facts) ? p.facts : [];
  if (facts.length)
    lines.push(
      `事实层：${facts
        .slice(0, 8)
        .map((f) =>
          typeof f === "string"
            ? f
            : [f.item, f.value].filter(Boolean).join("="),
        )
        .join("；")}`,
    );
  const inf = Array.isArray(p.inferences) ? p.inferences : [];
  if (inf.length)
    lines.push(
      `推断：${inf
        .slice(0, 5)
        .map((f) => (typeof f === "string" ? f : [f.item, f.value].filter(Boolean).join("=")))
        .join("；")}`,
    );
  if (typeof p.summary === "string" && p.summary.trim())
    lines.push(`小结：${p.summary.trim().slice(0, 300)}`);
  const pos = p.position;
  if (pos && typeof pos === "object")
    lines.push(`定位：${JSON.stringify(pos).slice(0, 200)}`);
  const tl = Array.isArray(p.timeline) ? p.timeline : [];
  if (tl.length)
    lines.push(
      `最近时间线：${tl
        .slice(-5)
        .map((e) => {
          const ev = e as Record<string, unknown>;
          return `${ev.t ?? ""} ${ev.who ?? ""}:${String(ev.text ?? "").slice(0, 40)}`;
        })
        .join(" / ")}`,
    );
  return lines.join("\n");
}

export function getProfile(id: string, userId?: string): unknown | null {
  const profilesDir = userId ? userDirs(userId).profilesDir : SHARED_PROFILES_DIR;
  const p = join(profilesDir, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

// ---------- 写（一律走 CLI，保证模板/备份/重建） ----------
export function profileNew(
  id: string,
  name: string,
  platform: string,
  verdict = "观察中",
  userId?: string,
): string {
  return run(["new", "--id", id, "--name", name, "--platform", platform, "--verdict", verdict], userId);
}

export function profileTimelineAdd(
  id: string,
  t: string,
  who: string,
  text: string,
  gap: string,
  userId?: string,
): string {
  return run(["timeline-add", "--id", id, "--t", t, "--who", who, "--text", text, "--gap", gap], userId);
}

export function profileScore(id: string, scores: Record<string, number>, userId?: string): string {
  const args = ["score", "--id", id];
  for (const [k, v] of Object.entries(scores)) args.push(`--${k}`, String(v));
  return run(args, userId);
}

export function profileVerdict(id: string, value: string, userId?: string): string {
  return run(["verdict", "--id", id, "--value", value], userId);
}

export function profileSet(id: string, field: string, value: unknown, userId?: string): string {
  return run([
    "set",
    "--id",
    id,
    "--field",
    field,
    "--value",
    typeof value === "string" ? value : JSON.stringify(value),
  ], userId);
}

/** patch 需要 JSON 文件路径，写临时文件后调用。 */
export function profilePatch(id: string, patch: Record<string, unknown>, userId?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dalang-patch-"));
  const file = join(dir, "patch.json");
  writeFileSync(file, JSON.stringify(patch), "utf-8");
  try {
    return run(["patch", "--id", id, "--file", file], userId);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function profileRebuild(userId?: string): string {
  return run(["rebuild"], userId);
}

/**
 * 本地/旧版资料库一键导入（2026-09-27）：旧用户用的是「本地页面 + 数据库」
 * （data/db.js 的 window.PROFILES 或 data/profiles/*.json），云端与本地同一套
 * schema——直接落盘完整档案（不经过 CLI 模板新建，保留 facts/inferences/plan
 * 等全部字段），再 rebuild 重建 index.json。
 */
export function profileImportLocal(
  userId: string | undefined,
  profiles: unknown[],
  overwrite: boolean,
): { imported: number; skipped: number; ids: string[] } {
  // 单机模式（userId=undefined）走共享库 profile_db/data，与老用户本地版档案库一致；
  // SaaS 走 userScope(userId) 的多用户隔离目录。
  const profilesDir = userId ? userScope(userId).profilesDir : SHARED_PROFILES_DIR;
  if (!userId) mkdirSync(profilesDir, { recursive: true });
  const ids: string[] = [];
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const raw of profiles) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const p = raw as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    // id 规范与 profile_cli.py 一致：^[a-z][a-z0-9_]*_[a-z]+$（拼音_平台）
    const id = String(p.id ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    if (!/^[a-z][a-z0-9_]*_[a-z]+$/.test(id) || !name || seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    const target = join(profilesDir, `${id}.json`);
    if (existsSync(target) && !overwrite) {
      skipped++;
      continue;
    }
    writeFileSync(target, JSON.stringify(p, null, 2), "utf-8");
    imported++;
    ids.push(id);
  }
  if (imported > 0) {
    try {
      run(["rebuild"], userId);
    } catch {
      /* 索引重建失败不阻断导入，前端刷新列表时会重新触发 */
    }
  }
  return { imported, skipped, ids };
}

export function profileValidate(id?: string, userId?: string): string {
  return id ? run(["validate", "--id", id], userId) : run(["validate"], userId);
}

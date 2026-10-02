import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import readline from "node:readline";
import {
  ST_ENV_PYTHON,
  DALANG_SKILL_DIR,
  WORKBENCH_DIR,
} from "./paths";
import { loadConfig, CLOUD_CORPUS_ID } from "./config";
import { RELATIONS, type AnalysisRequest } from "../shared/types";

export type RetrievedItem = Record<string, unknown>;
export type Retrieved = {
  cases: RetrievedItem[];
  rules: RetrievedItem[];
  templates: RetrievedItem[];
  strategies: RetrievedItem[];
};

/** 检索输入：local 用 query，cloud 用结构化四字段（云端自己拼 query）。 */
export type SearchInput = {
  query: string;
  situation: string;
  chatLog: string;
  girlProfile: string;
  userProfile: string;
  /**
   * 云端检索共享缓存的稳定 key（可选）。同一份聊天记录 / 同一个指导窗口
   * 传相同 key，即只消耗一次云端配额；不传则按全量输入精确缓存。
   * 背景：云端库是静态知识库（规则/话术/案例），每小时 50 次配额，
   * 一次完整分析原本要烧 1+N+1 次（首总览 + N 个逐句块 + 尾总览），极易打满。
   */
  cacheKey?: string;
};

const EMPTY: Retrieved = { cases: [], rules: [], templates: [], strategies: [] };
const CLIENT_VERSION = "1.2.0";
const TOKEN_SKEW_MS = 60 * 1000;

type CloudHit = { type: string; id: string; score: number; text?: string };

function bucketHits(hits: CloudHit[]): Retrieved {
  const out: Retrieved = {
    cases: [],
    rules: [],
    templates: [],
    strategies: [],
  };
  for (const h of hits) {
    const item: RetrievedItem = { id: h.id, score: h.score, text: h.text ?? "" };
    if (h.type === "case") out.cases.push(item);
    else if (h.type === "rule") out.rules.push(item);
    else if (h.type === "template") out.templates.push(item);
    else if (h.type === "strategy") out.strategies.push(item);
  }
  return out;
}

class VectorService {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<
    string,
    { resolve: (r: Retrieved) => void; reject: (e: Error) => void }
  >();
  private idleSince = 0;
  // 云端 token 缓存（内存，不落盘；license 本身已在 config.json）
  private cloudToken: string | null = null;
  private cloudTokenExpiresAt = 0;
  // ---------- 云端检索共享缓存（省配额核心） ----------
  // 云端库是静态知识库，同一窗口的检索结果短期复用零损失。
  // 2026-09-24 修复：用户反馈每小时 50 次配额「一下子就满了」——
  // 根因：一次完整分析 = 1+N+1 次检索（首总览 + N 个逐句块 + 尾总览），
  // 大浪指导每条消息 1 次，均无缓存。现在同窗口共享 1 次。
  private cache = new Map<string, { at: number; result: Retrieved }>();
  private readonly cacheTtlMs = 30 * 60 * 1000; // 知识库静态，30 分钟复用窗口
  private readonly cacheMax = 40; // LRU 上限（40 个聊天窗口）
  cacheHits = 0;
  cacheMisses = 0;
  // 最近一次云端检索元信息（给 /api/health 展示额度）
  lastCloudInfo: {
    resultId?: string;
    quotaUsed?: number;
    quotaLimit?: number;
    at?: number;
    fromCache?: boolean;
  } = {};

  private cacheKeyOf(input: SearchInput, topK: number): string {
    const raw = input.cacheKey
      ? `k|${topK}|${input.cacheKey}`
      : `f|${topK}|${JSON.stringify([
          input.situation,
          input.chatLog,
          input.girlProfile,
          input.userProfile,
          input.query,
        ])}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  // ---------- 云端向量库（https://dalang.wenmingjianyuce.cn） ----------

  private async cloudCall(
    base: string,
    route: string,
    opt: RequestInit & { token?: string },
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opt.token) headers["Authorization"] = `Bearer ${opt.token}`;
    const r = await fetch(base + route, {
      method: opt.method ?? "GET",
      headers,
      body: opt.body,
    });
    let d: Record<string, unknown> = {};
    try {
      d = (await r.json()) as Record<string, unknown>;
    } catch {
      /* 非 JSON 响应 */
    }
    if (!r.ok) {
      const err = (d.error ?? {}) as Record<string, unknown>;
      throw Object.assign(new Error(String(err.message || `HTTP ${r.status}`)), {
        code: String(err.code || "HTTP_ERROR"),
      });
    }
    return d;
  }

  private async ensureCloudToken(force = false): Promise<string> {
    const cfg = loadConfig();
    const license = cfg.embedding.apiKey;
    if (!license) {
      throw Object.assign(
        new Error("向量库 Key（license）未配置：请在「模型设置 → 向量库」里粘贴 key"),
        { code: "LICENSE_MISSING" },
      );
    }
    if (
      !force &&
      this.cloudToken &&
      this.cloudTokenExpiresAt > Date.now() + TOKEN_SKEW_MS
    ) {
      return this.cloudToken;
    }
    const { createHash } = await import("node:crypto");
    const { hostname, platform, arch } = await import("node:os");
    const deviceId = createHash("sha256")
      .update([hostname(), platform(), arch()].join("|"))
      .digest("hex")
      .slice(0, 24);
    const x = (await this.cloudCall(cfg.embedding.baseUrl, "/v1/auth/exchange", {
      method: "POST",
      body: JSON.stringify({
        license,
        client_version: CLIENT_VERSION,
        device_id: deviceId,
      }),
    })) as { access_token?: string; expires_in?: number };
    if (!x.access_token) throw new Error("云端换取 token 失败（无 access_token）");
    this.cloudToken = x.access_token;
    this.cloudTokenExpiresAt =
      Date.now() + Math.max(0, Number(x.expires_in || 0)) * 1000;
    return this.cloudToken;
  }

  private async cloudRetrieve(
    input: SearchInput,
    topK: number,
  ): Promise<Retrieved> {
    // 缓存命中 → 零配额消耗，直接返回（浅拷贝防调用方 mutation）
    const cacheKey = this.cacheKeyOf(input, topK);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      this.cache.delete(cacheKey); // LRU touch：删了重插 = 移到最新
      this.cache.set(cacheKey, cached);
      this.cacheHits++;
      this.lastCloudInfo = {
        ...this.lastCloudInfo,
        at: Date.now(),
        fromCache: true,
      };
      return {
        cases: [...cached.result.cases],
        rules: [...cached.result.rules],
        templates: [...cached.result.templates],
        strategies: [...cached.result.strategies],
      };
    }
    const cfg = loadConfig();
    let token = await this.ensureCloudToken();
    const body = JSON.stringify({
      corpus_id: CLOUD_CORPUS_ID,
      input: {
        situation: input.situation,
        girl_profile: input.girlProfile,
        chat_log: input.chatLog,
        user_profile: input.userProfile,
      },
      client_version: CLIENT_VERSION,
      compact: false,
      top_k: Math.min(8, Math.max(1, topK)),
    });
    const doRetrieve = () =>
      this.cloudCall(cfg.embedding.baseUrl, "/v1/retrieve", {
        method: "POST",
        token,
        body,
      });
    let d: Record<string, unknown>;
    try {
      d = await doRetrieve();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "TOKEN_INVALID" || /token|jwt|expired/i.test((e as Error).message)) {
        token = await this.ensureCloudToken(true);
        d = await doRetrieve();
      } else {
        throw e;
      }
    }
    const retrieval = (d.retrieval ?? {}) as { hits?: CloudHit[] };
    const quota = (d.quota ?? {}) as { used?: number; limit?: number };
    const result = bucketHits(
      Array.isArray(retrieval.hits) ? retrieval.hits : [],
    );
    this.cacheMisses++;
    // 写入缓存 + LRU 淘汰（超上限删最旧）
    this.cache.set(cacheKey, { at: Date.now(), result });
    if (this.cache.size > this.cacheMax) {
      const oldest = [...this.cache.entries()].sort(
        (a, b) => a[1].at - b[1].at,
      )[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.lastCloudInfo = {
      resultId: typeof d.result_id === "string" ? d.result_id : undefined,
      quotaUsed: Number(quota.used ?? 0),
      quotaLimit: Number(quota.limit ?? 0),
      at: Date.now(),
      fromCache: false,
    };
    return result;
  }

  // ---------- 本地向量守护进程（provider=local/openai 时启用） ----------

  private ensure(): Promise<void> {
    if (this.proc) return this.ready!;
    this.ready = new Promise<void>((resolve, reject) => {
      const config = loadConfig();
      const env = {
        ...process.env,
        DALANG_SKILL_DIR,
        DALANG_EMBED_PROVIDER: config.embedding.provider,
        DALANG_EMBED_BASE_URL: config.embedding.baseUrl,
        DALANG_EMBED_API_KEY: config.embedding.apiKey,
        DALANG_EMBED_MODEL: config.embedding.model,
      };
      const proc = spawn(
        ST_ENV_PYTHON,
        [join(WORKBENCH_DIR, "scripts", "retrieve_daemon.py")],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.proc = proc;
      const rl = readline.createInterface({ input: proc.stdout });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("向量检索模型加载超时（>120s）"));
          proc.kill();
        }
      }, 120000);
      rl.on("line", (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (!settled) {
          if (msg.ready) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        const id = String(msg.id ?? "");
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (msg.ok) p.resolve(msg as unknown as Retrieved);
        else p.reject(new Error(String(msg.error || "向量检索失败")));
      });
      proc.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        if (s.trim()) console.error("[vector]", s.trim());
      });
      proc.on("error", (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });
      proc.on("exit", (code) => {
        this.proc = null;
        this.ready = null;
        const err = new Error(`向量检索进程退出 (code ${code ?? "?"})`);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      });
    });
    return this.ready!;
  }

  private async localRetrieve(
    query: string,
    topK: number,
  ): Promise<Retrieved> {
    await this.ensure();
    if (!this.proc) return EMPTY;
    this.idleSince = Date.now();
    const id = randomUUID();
    return new Promise<Retrieved>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("向量检索超时（>15s）"));
      }, 15000);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc!.stdin.write(JSON.stringify({ id, query, top_k: topK }) + "\n");
    });
  }

  async search(input: SearchInput, topK = 5): Promise<Retrieved> {
    const cfg = loadConfig();
    if (cfg.embedding.provider === "cloud") {
      return this.cloudRetrieve(input, topK);
    }
    return this.localRetrieve(input.query, topK);
  }

  /** embedding 配置变化后重启：本地杀守护进程、云端清 token 与检索缓存，下次 search 自动重建。 */
  restart() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.ready = null;
    }
    this.cloudToken = null;
    this.cloudTokenExpiresAt = 0;
    this.cache.clear();
  }

  get mode(): "cloud" | "local" {
    return loadConfig().embedding.provider === "cloud" ? "cloud" : "local";
  }

  /**
   * license 有效性探测（模型设置「跑通」判定用）：
   * 强制重新换 token，成功 = license 有效。exchange 不计入检索配额，零检索消耗。
   */
  async verifyLicense(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.ensureCloudToken(true);
      return { ok: true, detail: "license 有效，向量库连通" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

export const vectorService = new VectorService();

// ---------- 检索输入构造（GPT / Jev 共用，2026-10-01 从 analysis.ts 迁来） ----------
// 放在 vector.ts 是为了避免 analysis.ts ↔ jev.ts 循环依赖：两条分析路径都要
// 用同一套「检索输入 + 共享缓存 key」，检索结果才能互享、配额只烧一次。

export function buildSearchInput(input: AnalysisRequest): SearchInput {
  const chatLog = input.messages
    .slice(-40)
    .map(
      (m) =>
        `${m.timestamp ? `[${m.timestamp}] ` : ""}${m.sender === "self" ? "我" : "她"}: ${m.text}`,
    )
    .join("\n");
  const situation = `${RELATIONS[input.relation]}｜任务:${input.task}`;
  return {
    query: buildQuery(input),
    situation,
    chatLog,
    girlProfile: "",
    userProfile: "",
  };
}

function buildQuery(input: AnalysisRequest): string {
  const text = input.messages
    .slice(-20)
    .map((m) => m.text)
    .join(" ");
  return `${RELATIONS[input.relation]} ${text}`.slice(0, 1200);
}

/**
 * 云端检索共享缓存的稳定 key：同一份聊天记录 → 同一个 key。
 * 2026-09-24 修复配额打满：一次完整分析原本 = 1+N+1 次检索（首总览 +
 * N 个逐句块 + 尾总览），每个 job 检索窗口不同、零缓存，100 条消息的
 * 聊天一次烧 7-10 次配额。现在同一次会话所有 job 共享 1 次检索。
 * key 用「relation + profileId + 消息 id 序列」——增量追加时前缀稳定，
 * 旧窗口命中缓存，新增消息生成新 key（id 序列变了）。
 */
export function retrievalCacheKey(input: AnalysisRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "analyze",
        input.relation,
        input.profileId ?? "",
        input.messages.map((m) => m.id).join(","),
      ]),
    )
    .digest("hex");
}

import { createHash } from "node:crypto";
import { loadConfig } from "./config";
import { EMOTIONS } from "../shared/labels";
import { INTENTS } from "../shared/intents";
import { EVENT_KINDS, type MemoryEvent } from "../shared/memory";
import {
  RUBRIC,
  requestContextKey,
  type AnalysisRequest,
  type AnalysisResponse,
  type Judgment,
  type LineResult,
  type Overview,
} from "../shared/types";
import {
  AFFINITY_DIMENSIONS,
  type AffinityDimension,
} from "../shared/affinity";
import type { TokenUsage } from "./relay";
import {
  vectorService,
  buildSearchInput,
  retrievalCacheKey,
  type Retrieved,
} from "./vector";

/**
 * Jev 快速判断客户端（走我们中转站 OpenAI 兼容的 chat/completions，2026-10-01 主人定板）。
 * 与 GPT 分工：逐条情绪/意图/打分走这里（结构化 JSON、快、便宜），
 * 好感度总览 / 开场白 / 图片 / 深度分析仍走 GPT（analysis.ts 主路径）。
 */

export class JevError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

type JevAnswer = {
  type?: "choice" | "score" | "noul";
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};

// 标签库 → Choice criteria（key = 标签 key，value = 判定依据描述）
const EMOTION_CRITERIA: Record<string, string> = Object.fromEntries(
  Object.entries(EMOTIONS).map(([k, v]) => [k, v.criteria]),
);
const INTENT_CRITERIA: Record<string, string> = Object.fromEntries(
  Object.entries(INTENTS).map(([k, v]) => [k, v.criteria]),
);
// EVENT_KINDS 本身就是 key -> 描述
const EVENT_CRITERIA: Record<string, string> = { ...EVENT_KINDS };

// self_message 质量分 5 档（对齐 types.ts grade：刹车/有点尬/一般/稳/妙）
const QUALITY_CRITERIA = ["踩雷/减分", "有点尬", "一般", "稳", "妙/高情商"];
const QUALITY_BANDS = [10, 30, 50, 70, 90];

function clamp01(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

// 单批问题数上限：保守分批。透传（system 放 questions JSON）走 shim→systemone 后
// 理论上可一次全量，待实测确认后再放开。
const JEV_BATCH_SIZE = 8;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 从 chat/completions 返回的文本里容错解析出 answers（容忍代码块包裹、前后杂字）。 */
function parseJevAnswers(content: string): Record<string, JevAnswer> {
  let text = (content ?? "").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const answers = (
    obj.answers && typeof obj.answers === "object" ? obj.answers : obj
  ) as Record<string, unknown>;
  const out: Record<string, JevAnswer> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!v || typeof v !== "object") continue;
    const a = v as Record<string, unknown>;
    const ans: JevAnswer = {};
    if (typeof a.choice === "string") ans.choice = a.choice;
    if (typeof a.score === "number") ans.score = a.score;
    if (typeof a.noul === "number") ans.noul = a.noul;
    if (a.probabilities && typeof a.probabilities === "object") {
      const p: Record<string, number> = {};
      for (const [pk, pv] of Object.entries(a.probabilities as Record<string, unknown>)) {
        const n = Number(pv);
        if (Number.isFinite(n) && n > 0 && n <= 1) p[pk] = n;
      }
      if (Object.keys(p).length) ans.probabilities = p;
    }
    if (typeof a.confidence === "number") ans.confidence = a.confidence;
    else if (ans.probabilities) {
      const vals = Object.values(ans.probabilities);
      if (vals.length) ans.confidence = Math.max(...vals);
    }
    out[k] = ans;
  }
  return out;
}

/** 单次 chat/completions 调用（一批问题），带限流退避重试，返回 answers + token 用量。 */
async function jevJudgeOnce(
  state: string,
  questions: Record<string, JevQuestion>,
  jev: { baseUrl: string; apiKey: string; model: string },
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ answers: Record<string, JevAnswer>; usage: TokenUsage }> {
  const base = jev.baseUrl.replace(/\/+$/, "");
  // 上游对连发 ~4 次就 403 限流，指数退避重试（15s/30s/60s）
  const backoffMs = [15000, 30000, 60000];

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30000);
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;
    try {
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jev.apiKey}`,
        },
        body: JSON.stringify({
          model: jev.model,
          messages: [
            // 传法 S2：questions 的 JSON 放 system 消息（shim 三级透传第二级）。
            // 不放顶层 questions 字段——非标准字段会被 Cloudflare WAF 1010 拦截。
            { role: "system", content: JSON.stringify(questions) },
            { role: "user", content: state },
          ],
          temperature: 0,
        }),
        signal,
      });

      // 限流退避：403/429 且还有重试机会 → 等待后重试
      if ((resp.status === 403 || resp.status === 429) && attempt < backoffMs.length) {
        const wait = backoffMs[attempt];
        clearTimeout(timer);
        console.warn(`[jev] 触发限流(${resp.status})，${wait / 1000}s 后重试（第 ${attempt + 1} 次）`);
        await sleep(wait);
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new JevError(
          `Jev 返回 ${resp.status}${errText ? `：${errText.slice(0, 200)}` : ""}`,
          resp.status,
        );
      }

      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: Record<string, number>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const u = data.usage ?? {};
      return {
        answers: parseJevAnswers(content),
        usage: {
          input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
          output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
        },
      };
    } catch (e) {
      if (e instanceof JevError) throw e;
      if ((e as Error).name === "AbortError")
        throw new JevError("Jev 请求超时或已取消", 504);
      throw new JevError(`Jev 请求失败：${(e as Error).message}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 核心调用：POST /v1/chat/completions（OpenAI 兼容），分批提问、JSON 解析，返回结构化 answers + token 用量。 */
export async function jevJudge(
  state: string,
  questions: Record<string, JevQuestion>,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ answers: Record<string, JevAnswer>; usage: TokenUsage }> {
  const config = loadConfig();
  if (!config.jev.apiKey)
    throw new JevError("尚未配置 Jev API Key，请在「模型设置」里填写", 503);
  const entries = Object.entries(questions);
  if (!entries.length)
    return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };

  // 分批：一批问太多会撑爆 Jev 的 chat 输出上限，导致 JSON 截断
  const batches: Record<string, JevQuestion>[] = [];
  for (let i = 0; i < entries.length; i += JEV_BATCH_SIZE) {
    batches.push(Object.fromEntries(entries.slice(i, i + JEV_BATCH_SIZE)));
  }

  const answers: Record<string, JevAnswer> = {};
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  for (const batch of batches) {
    const r = await jevJudgeOnce(state, batch, config.jev, opts);
    Object.assign(answers, r.answers);
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
  }
  return { answers, usage };
}

function toEvent(
  raw: JevAnswer | undefined,
): { kind: MemoryEvent["kind"]; confidence: number } {
  const kind = String(raw?.choice ?? "none");
  const valid = kind in EVENT_KINDS ? (kind as MemoryEvent["kind"]) : "none";
  const conf = clamp01(Number(raw?.confidence ?? 0.5));
  return { kind: valid, confidence: valid === "none" ? 0 : conf };
}

function filterTo(
  raw: unknown,
  allowed: Record<string, unknown>,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in allowed)) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n <= 1) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function mapQuality(raw: JevAnswer | undefined): number | null {
  const n = Number(raw?.score);
  if (!Number.isFinite(n)) return null;
  const idx = Math.max(0, Math.min(QUALITY_BANDS.length - 1, Math.round(n)));
  return QUALITY_BANDS[idx];
}

function makeJudgment(value: number | null, confidence: number) {
  const status =
    confidence < 0.35
      ? ("insufficient" as const)
      : confidence < 0.65
        ? ("ambiguous" as const)
        : ("clear" as const);
  return { value, confidence, status, probabilities: {} };
}

/**
 * Jev 用紧凑版检索结果：Jev 按输入 token 计费，块越小越省（$0.042/M 很便宜但别浪费）。
 * 只保留「能校准判断」的信息：规则一条一行、策略/案例压成单行，砍掉模板细节。
 */
function compactRetrieved(r: Retrieved): string {
  const parts: string[] = [];
  for (const x of r.rules.slice(0, 3))
    parts.push(
      `【规则】${x.category ? `[${x.category}] ` : ""}${x.text ?? x.rule ?? ""}`,
    );
  for (const x of r.strategies.slice(0, 2)) {
    if (x.text && !x.title) parts.push(`【策略】${x.text}`);
    else parts.push(`【策略】${x.title ?? ""}：${x.window_10 ?? ""}`);
  }
  for (const x of r.cases.slice(0, 2))
    parts.push(
      x.text && !x.situation
        ? `【案例】${x.text}`
        : `【案例】场景：${x.situation ?? ""}｜判断：${x.analysis ?? ""}｜建议：${x.recommendation ?? ""}`,
    );
  return parts.filter(Boolean).join("\n");
}

/**
 * 用 Jev 对逐条消息做快速判断：
 * - other_messages → 情绪(Choice) + 意图(Choice) + 事件(Choice)
 * - self_message   → 质量分(Score 5 档) + 事件(Choice)
 * 一次调用批量问完，返回与 GPT 同构的 AnalysisResponse.lines。
 */
export async function analyzeLinesViaJev(
  input: AnalysisRequest,
  opts?: { signal?: AbortSignal; onUsage?: (u: TokenUsage) => void },
): Promise<AnalysisResponse> {
  const start = performance.now();
  const messages = input.messages;
  const indexById = new Map(messages.map((m, i) => [m.id, i]));
  const targets = input.targetIds
    .map((id) => indexById.get(id))
    .filter((i): i is number => i !== undefined);
  const textTargets = targets.filter((i) => messages[i].kind === "text");

  // 🔴 contextHash 必须与前端校验（useAnalysis.executeJob）和 GPT 路径（analysis.ts）
  // 完全同源：sha256(requestContextKey(input))。v2.28 曾自造 hash 公式
  // [revision, targetIds, 消息id]，前端一比对就报「分析上下文不匹配，请重试」。
  const contextHash = createHash("sha256")
    .update(requestContextKey(input))
    .digest("hex");

  const base: AnalysisResponse = {
    revision: input.revision,
    contextHash,
    model: "jev-1.13.0",
    rubricVersion: RUBRIC,
    usage: { input_tokens: 0, output_tokens: 0 },
    latencyMs: Math.round(performance.now() - start),
  };

  if (!textTargets.length) {
    base.lines = [];
    return base;
  }

  // 🔴 向量库检索前置（2026-10-01 主人定板：Jev 也必须吃大浪实战库再判断，增准确度）。
  // 与 GPT 路径共用 buildSearchInput/retrievalCacheKey（同库同缓存体系）。
  // 云端模式检索失败 → 硬门抛错（回退 GPT 后同样硬门失败，与「检索是分析硬前提」铁律一致）；
  // 本地模式降级为无检索继续判断。
  let retrievalBlock = "";
  let retrievalHits: AnalysisResponse["retrievalHits"];
  try {
    const searchInput = buildSearchInput(input);
    searchInput.cacheKey = retrievalCacheKey(input);
    const retrieved = await vectorService.search(searchInput, 3);
    retrievalBlock = compactRetrieved(retrieved);
    const hits = (
      [
        ...retrieved.rules,
        ...retrieved.strategies,
        ...retrieved.cases,
        ...retrieved.templates,
      ] as { id?: unknown; score?: unknown }[]
    )
      .filter((x) => typeof x.id === "string")
      .map((x) => ({
        id: x.id as string,
        score: Number(x.score ?? 0),
        type: String(x.id as string).split("_")[0] || "item",
      }));
    if (hits.length) retrievalHits = hits;
  } catch (e) {
    const msg = (e as Error).message;
    if (vectorService.mode === "cloud")
      throw new JevError(`云端向量库检索失败：${msg}`, 502);
    console.error("[jev] 向量检索失败，降级为无检索：", msg);
  }

  // state：检索参考资料在前（要求校准判断），带编号的消息列表在后，供 questions 按序号指认
  const state = [
    retrievalBlock
      ? `# 大浪实战库参考（以下是本场景命中的规则/策略/案例，判断时结合它们校准，不要照抄话术）\n${retrievalBlock}`
      : "",
    messages
      .map((m, i) => `[${i}] ${m.sender === "self" ? "我" : "她"}: ${m.text}`)
      .join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const questions: Record<string, JevQuestion> = {};
  for (const i of textTargets) {
    const m = messages[i];
    if (m.sender === "other") {
      questions[`m${i}_emotion`] = {
        type: "choice",
        instructions: `第 ${i} 条消息（她）的主要情绪是？`,
        criteria: EMOTION_CRITERIA,
      };
      questions[`m${i}_intent`] = {
        type: "choice",
        instructions: `第 ${i} 条消息（她）的主要沟通意图是？`,
        criteria: INTENT_CRITERIA,
      };
      questions[`m${i}_event`] = {
        type: "choice",
        instructions: `第 ${i} 条消息（她）是否属于以下事件类型？`,
        criteria: EVENT_CRITERIA,
      };
    } else {
      questions[`m${i}_quality`] = {
        type: "score",
        instructions: `第 ${i} 条消息（我）这条回复的质量如何？`,
        criteria: QUALITY_CRITERIA,
      };
      questions[`m${i}_event`] = {
        type: "choice",
        instructions: `第 ${i} 条消息（我）是否属于以下事件类型？`,
        criteria: EVENT_CRITERIA,
      };
    }
  }

  const { answers, usage } = await jevJudge(state, questions, {
    signal: opts?.signal,
  });
  opts?.onUsage?.(usage);
  base.usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
  base.latencyMs = Math.round(performance.now() - start);
  if (retrievalHits) base.retrievalHits = retrievalHits;

  const lines: LineResult[] = [];
  for (const i of textTargets) {
    const m = messages[i];
    if (m.sender === "other") {
      lines.push({
        id: m.id,
        event: toEvent(answers[`m${i}_event`]),
        score: { value: null, confidence: 0.5, status: "ambiguous", probabilities: {} },
        emotions: filterTo(answers[`m${i}_emotion`]?.probabilities, EMOTIONS),
        intents: filterTo(answers[`m${i}_intent`]?.probabilities, INTENTS),
      });
    } else {
      const q = answers[`m${i}_quality`];
      const value = mapQuality(q);
      const conf = clamp01(Number(q?.confidence ?? 0.5));
      lines.push({
        id: m.id,
        event: toEvent(answers[`m${i}_event`]),
        score: makeJudgment(value, conf),
      });
    }
  }
  base.lines = lines;
  return base;
}

/**
 * 好感度六维 + 边界，用 Jev 快速判定（2026-10-01 主人定板「分析好感度也用 JEV 配合向量库」）。
 * 下一步动作/话术仍走 GPT（那是关键价值）。这里只产出 Overview 的 affinity 相关字段。
 * 每维一个 Choice（5 档 levels 已内建在 AFFINITY_DIMENSIONS），边界一个 Noul。
 */
export type JevAffinity = {
  affinity: Judgment;
  affinityDimensions: AffinityDimension[];
  affinityRawValue?: number;
  boundaryApplied: boolean;
};

const AFFINITY_BAND_VALUES = [0, 25, 50, 75, 100];

export async function analyzeAffinityViaJev(
  input: AnalysisRequest,
  retrieved: Retrieved,
  opts?: { signal?: AbortSignal; onUsage?: (u: TokenUsage) => void },
): Promise<JevAffinity> {
  const state = [
    compactRetrieved(retrieved)
      ? `# 大浪实战库参考（判断好感度时结合校准）\n${compactRetrieved(retrieved)}`
      : "",
    input.messages
      .map((m, i) => `[${i}] ${m.sender === "self" ? "我" : "她"}: ${m.text}`)
      .join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const questions: Record<string, JevQuestion> = {};
  for (const d of AFFINITY_DIMENSIONS) {
    const criteria: Record<string, string> = {};
    d.levels.forEach((lv, i) => {
      criteria[`L${i}`] = lv;
    });
    questions[`dim_${d.key}`] = {
      type: "choice",
      instructions: `对方对「${d.label}」的接近程度？${d.question}`,
      criteria,
    };
  }
  questions["boundary"] = {
    type: "noul",
    instructions:
      "对方是否存在仍有效的拒绝边界（明确拒绝/只做朋友/要求停止推进）？0=无，1=明确存在且仍有效",
  };

  const { answers, usage } = await jevJudge(state, questions, {
    signal: opts?.signal,
  });
  opts?.onUsage?.(usage);

  const dims: AffinityDimension[] = AFFINITY_DIMENSIONS.map((d) => {
    const a = answers[`dim_${d.key}`];
    const idx = a?.choice
      ? Number(String(a.choice).replace(/^L/, ""))
      : -1;
    const value =
      Number.isInteger(idx) && idx >= 0 && idx < AFFINITY_BAND_VALUES.length
        ? AFFINITY_BAND_VALUES[idx]
        : null;
    const conf = clamp01(Number(a?.confidence ?? 0.5));
    return {
      key: d.key,
      label: d.label,
      weight: d.weight,
      judgment: makeJudgment(value, conf),
    };
  });
  const boundary = clamp01(Number(answers.boundary?.noul ?? 0));
  const totalW = dims.reduce((s, d) => s + d.weight, 0) || 1;
  const allHave = dims.every((d) => d.judgment.value !== null);
  const rawValue = allHave
    ? Math.round(dims.reduce((s, d) => s + d.weight * (d.judgment.value as number), 0) / totalW)
    : undefined;
  const confidence =
    dims.reduce((s, d) => s + d.weight * d.judgment.confidence, 0) / totalW;
  const boundaryApplied = boundary >= 0.8;
  const status = dims.some((d) => d.judgment.status === "insufficient")
    ? "insufficient"
    : dims.some((d) => d.judgment.status === "ambiguous")
      ? "ambiguous"
      : "clear";

  return {
    affinity: {
      value: boundaryApplied ? Math.min(25, rawValue ?? 0) : rawValue ?? null,
      confidence,
      status,
      probabilities: {},
    },
    affinityDimensions: dims,
    affinityRawValue: rawValue,
    boundaryApplied,
  };
}

/** 配置测试用：探活 Jev（发一个 1 问的最小请求，几乎零成本）。 */
export async function testJev(): Promise<{ ok: boolean; detail: string }> {
  const config = loadConfig();
  if (!config.jev.apiKey) return { ok: false, detail: "未配置 Jev API Key" };
  try {
    const { answers } = await jevJudge("你好", {
      ping: { type: "noul", instructions: "这条消息是否友好" },
    });
    const ok = typeof answers.ping?.noul === "number";
    return { ok, detail: ok ? "Jev 连通" : "Jev 返回异常" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

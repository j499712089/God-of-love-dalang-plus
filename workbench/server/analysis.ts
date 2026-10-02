import { createHash } from "node:crypto";
import { AFFINITY_DIMENSIONS } from "../shared/affinity";
import { EMOTIONS } from "../shared/labels";
import { INTENTS } from "../shared/intents";
import { EVENT_KINDS, type MemoryEvent } from "../shared/memory";
import {
  RUBRIC,
  RELATIONS,
  ACTIONS,
  requestContextKey,
  type AnalysisRequest,
  type AnalysisResponse,
  type Judgment,
  type LineResult,
  type Overview,
  type Message,
  type ImageInsight,
} from "../shared/types";
import {
  vectorService,
  buildSearchInput,
  retrievalCacheKey,
  type Retrieved,
  type SearchInput,
} from "./vector";
import { buildSystemPrompt, buildUserPrompt } from "./agent";
import { chatCompletion, type TokenUsage } from "./relay";
import { profileSummary } from "./profile";
import { loadConfig } from "./config";
import { analyzeLinesViaJev, analyzeAffinityViaJev, type JevAffinity } from "./jev";

const EMPTY_RETRIEVED: Retrieved = {
  cases: [],
  rules: [],
  templates: [],
  strategies: [],
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function clamp01(n: number) {
  return Number.isFinite(n) ? clamp(n, 0, 1) : 0;
}

function extractJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start)
    throw new Error("模型未返回可解析的 JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

function makeJudgment(value: number | null, confidence: number): Judgment {
  const status =
    confidence < 0.35
      ? ("insufficient" as const)
      : confidence < 0.65
        ? ("ambiguous" as const)
        : ("clear" as const);
  return { value, confidence, status, probabilities: {} };
}

function resolveIndex(ref: unknown): number | null {
  if (ref == null) return null;
  const n = Number(String(ref).replace(/^#/, ""));
  return Number.isInteger(n) ? n : null;
}

function resolveId(ref: unknown, messages: Message[]): string | null {
  const n = resolveIndex(ref);
  if (n == null || n < 0 || n >= messages.length) return null;
  return messages[n].id;
}

// buildQuery / buildSearchInput / retrievalCacheKey 已迁至 vector.ts（2026-10-01），
// 供 GPT 与 Jev 两条分析路径共用同一套检索输入与共享缓存 key，避免循环依赖。

function filterProb(
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

function toEvent(raw: unknown): { kind: MemoryEvent["kind"]; confidence: number } {
  const kind = String(raw ?? "none");
  const valid = kind in EVENT_KINDS ? (kind as MemoryEvent["kind"]) : "none";
  return { kind: valid, confidence: valid === "none" ? 0 : 0.6 };
}

function toOverview(input: AnalysisRequest, p: Record<string, unknown>): Overview {
  const affinity = (p.affinity ?? {}) as Record<string, unknown>;
  const conf = clamp01(Number(p.affinity_confidence ?? 0.5));
  const dimensions = AFFINITY_DIMENSIONS.map((d) => {
    const raw = Number(affinity[d.key]);
    const value = Number.isFinite(raw) ? clamp(raw, 0, 100) : null;
    return {
      key: d.key,
      label: d.label,
      weight: d.weight,
      judgment: makeJudgment(value, conf),
    };
  });
  const boundary = clamp01(Number(p.boundary ?? 0));
  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0) || 1;
  const rawValue = dimensions.every((d) => d.judgment.value !== null)
    ? Math.round(
        dimensions.reduce((s, d) => s + d.weight * (d.judgment.value as number), 0) /
          totalWeight,
      )
    : null;
  const boundaryApplied = boundary >= 0.8;
  const affinityJudgment: Judgment = {
    value: boundaryApplied ? Math.min(25, rawValue ?? 0) : rawValue,
    confidence: conf,
    status: dimensions.some((d) => d.judgment.status === "insufficient")
      ? "insufficient"
      : dimensions.some((d) => d.judgment.status === "ambiguous")
        ? "ambiguous"
        : "clear",
    probabilities: {},
  };

  let action = String(p.action ?? "insufficient");
  if (!(action in ACTIONS)) action = "insufficient";
  const pending = clamp01(Number(p.pending ?? 0));
  if (boundary >= 0.8) action = "respect";
  else if (pending >= 0.75) action = "wait";

  const stageRaw = String(p.stage ?? "unknown");
  const stage = ["unknown", "contact", "flow", "flirt", "date", "mutual"].includes(stageRaw)
    ? stageRaw
    : "unknown";

  return {
    memoryEvidenceIds: (input.memory ?? []).flatMap((e) => [
      e.id,
      ...(e.resolvedBy ? [e.resolvedBy] : []),
    ]),
    contextCount: input.messages.length,
    affinity: affinityJudgment,
    affinityDimensions: dimensions,
    affinityRawValue: rawValue ?? undefined,
    boundaryApplied,
    stage,
    action,
    evidenceId: resolveId(p.evidence, input.messages),
    actionEvidenceId: resolveId(p.action_evidence, input.messages),
    nextReply: typeof p.next_reply === "string" ? p.next_reply : undefined,
    nextReplyNote: typeof p.next_reply_note === "string" ? p.next_reply_note : undefined,
    risks: Array.isArray(p.risks) ? p.risks.map(String) : undefined,
    note: typeof p.note === "string" ? p.note : undefined,
    rounds: parseRounds(p.rounds),
    fiveStep: parseFiveStep(p.five_step),
  };
}

function parseRounds(raw: unknown): Overview["rounds"] {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((x, i) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 600) : "");
      return {
        round: Number.isInteger(Number(o.round)) ? Number(o.round) : i + 1,
        goal: s(o.goal),
        reply: s(o.reply),
        watch: s(o.watch) || undefined,
        ifGood: s(o.if_good) || undefined,
        ifCold: s(o.if_cold) || undefined,
        ifShift: s(o.if_shift) || undefined,
      };
    })
    .filter((r) => r.goal || r.reply)
    .slice(0, 3);
  return out.length ? out : undefined;
}

function parseFiveStep(raw: unknown): Overview["fiveStep"] {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 800) : "");
  const out = {
    emotion: s(o.emotion),
    facts: s(o.facts),
    interest: s(o.interest),
    advice: s(o.advice),
    action: s(o.action),
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}

function toLines(input: AnalysisRequest, p: Record<string, unknown>): LineResult[] {
  const lines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]) : [];
  const indexToId = new Map(input.messages.map((m, i) => [i, m.id]));
  const out: LineResult[] = [];
  for (const l of lines) {
    const n = resolveIndex(l.id);
    if (n == null || !indexToId.has(n)) continue;
    const realId = indexToId.get(n)!;
    const m = input.messages[n];
    const event = toEvent(l.event);
    if (input.task === "other_messages") {
      out.push({
        id: realId,
        event,
        score: {
          value: null,
          confidence: clamp01(Number(l.confidence ?? 0.5)),
          status: "ambiguous",
          probabilities: {},
        },
        emotions: filterProb(l.emotions, EMOTIONS),
        intents: filterProb(l.intents, INTENTS),
      });
    } else {
      const rawScore = Number(l.score);
      const value = Number.isFinite(rawScore) ? clamp(rawScore, 0, 100) : null;
      const conf = clamp01(Number(l.confidence ?? 0.5));
      const enough = String(l.enough ?? "limited");
      const status =
        enough === "insufficient" || conf < 0.35
          ? ("insufficient" as const)
          : enough === "limited" || conf < 0.65
            ? ("ambiguous" as const)
            : ("clear" as const);
      out.push({
        id: realId,
        event,
        score: { value, confidence: conf, status, probabilities: {} },
      });
    }
    void m;
  }
  return out;
}

/**
 * 图片视觉分析指令：要求模型在 JSON 里额外输出 image_insights 数组。
 * 只在总览任务 + 有图时拼接。
 */
export function imagePrompt(images: NonNullable<AnalysisRequest["images"]>): string {
  const n = images.length;
  return `

## 附带图片（${n} 张）
用户在聊天记录外附上了 ${n} 张图片（按顺序编号 1-${n}，可能是她的照片、朋友圈截图或资料页截图）。请逐张读取并分析，在 JSON 输出里增加 "image_insights" 数组（长度 = ${n}，按图片顺序），每项：
- "image_id": 图片顺序号（数字 1-${n}）
- "tags": 穿搭/造型风格标签数组（2-5 个，如「学院风」「clean fit」「运动风」「精致妆容」；没有人物就给画面风格标签）
- "scene": 场景与生活状态线索（一句话，如「健身房自拍，生活规律」「下午茶探店，消费中上」）
- "authenticity": 真实性评估（从「生活照」「精修图」「疑似网图」「疑似AI生成」「截图存证」中选，并附一句依据）
- "note": 综合解读（2-3 句：气质印象、消费层级、性格外向/内敛线索、与聊天文字呈现的人设是否一致；若与资料卡或聊天内容矛盾，明确指出）
注意：图片只是辅助证据，不要凭外貌对任何人做主观贬低；网图/AI 特征只做提示性描述，不下绝对结论。`;
}

/** 把 user prompt（string）+ 图片组装成 vision content parts。 */
export function buildVisionContent(
  user: string,
  images: NonNullable<AnalysisRequest["images"]>,
): import("./relay").ContentPart[] {
  const parts: import("./relay").ContentPart[] = [{ type: "text", text: user }];
  for (const img of images) {
    if (/^data:image\/(jpeg|png|webp);base64,/.test(img.dataUrl))
      parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  return parts;
}

export function toImageInsights(
  raw: unknown,
  images: NonNullable<AnalysisRequest["images"]>,
): ImageInsight[] {
  const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: ImageInsight[] = [];
  for (const item of arr) {
    const idx = Number(item.image_id);
    const img = Number.isInteger(idx) && idx >= 1 && idx <= images.length ? images[idx - 1] : undefined;
    if (!img) continue;
    out.push({
      imageId: img.id,
      tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 6) : [],
      scene: typeof item.scene === "string" ? item.scene.slice(0, 200) : undefined,
      authenticity: typeof item.authenticity === "string" ? item.authenticity.slice(0, 120) : undefined,
      note: typeof item.note === "string" ? item.note.slice(0, 600) : "",
    });
  }
  return out;
}

export async function analyze(
  input: AnalysisRequest,
  signal?: AbortSignal,
  userId?: string,
  onUsage?: (u: TokenUsage) => void,
  onJevUsage?: (u: TokenUsage) => void,
): Promise<AnalysisResponse> {
  // 🔴 Jev/GPT 分工（2026-10-01 主人定板）：
  // 逐条情绪/意图/打分（other_messages / self_message）走 Jev（TypeSafe System One，
  // 结构化、70-500ms、成本≈GPT 的 1/30），不烧向量库检索、不烧 GPT token；
  // 好感度六维（overview 的 affinity）也走 Jev + 向量库（下方 analyzeAffinityViaJev）；
  // 下一步动作/话术/五步链路（action/next_reply/five_step/rounds）仍走 GPT 深度分析
  // （那是关键价值）。Jev 异常自动回退 GPT，保证不中断。
  if (input.task !== "overview" && loadConfig().jev.apiKey) {
    try {
      return await analyzeLinesViaJev(input, { signal, onUsage: onJevUsage });
    } catch (e) {
      console.error("[analyze] Jev 快速判断失败，回退 GPT：", (e as Error).message);
      // 回退到下方 GPT 深度分析
    }
  }

  const start = performance.now();
  const contextHash = createHash("sha256")
    .update(requestContextKey(input))
    .digest("hex");

  let retrieved: Retrieved = EMPTY_RETRIEVED;
  const profile = input.profileId ? profileSummary(input.profileId, userId) : null;
  const searchInput = buildSearchInput(input);
  if (profile) searchInput.girlProfile = profile.slice(0, 1500);
  searchInput.cacheKey = retrievalCacheKey(input);
  try {
    retrieved = await vectorService.search(searchInput, 5);
  } catch (e) {
    const msg = (e as Error).message;
    if (vectorService.mode === "cloud") {
      // 云端模式 = 大浪库检索是分析硬门，失败不降级，直接把错误抛给前端
      throw new Error(`云端向量库检索失败：${msg}`);
    }
    console.error("[analyze] 向量检索失败，降级为无检索：", msg);
  }

  // 🔴 好感度六维走 Jev（2026-10-01）：检索命中 + 聊天记录 → Jev 快速判六维 + 边界。
  // 成功则注入 GPT 提示词作上下文，并最终覆盖 GPT 的好感度输出；失败则 GPT 照旧全量判。
  let jevAffinity: JevAffinity | undefined;
  if (input.task === "overview" && loadConfig().jev.apiKey) {
    try {
      jevAffinity = await analyzeAffinityViaJev(input, retrieved, {
        signal,
        onUsage: onJevUsage,
      });
    } catch (e) {
      console.error("[analyze] Jev 好感度判定失败，回退 GPT：", (e as Error).message);
      jevAffinity = undefined;
    }
  }

  const system = buildSystemPrompt(retrieved, input.relation, profile ?? undefined);
  let user = buildUserPrompt(input);
  if (jevAffinity) {
    const dims = jevAffinity.affinityDimensions
      .map((d) => `- ${d.label}：${d.judgment.value ?? "未知"}`)
      .join("\n");
    user += `\n\n## 好感度六维（快速模型已判定，供你写 action/next_reply 时参考，不必重复计算）\n${dims}\n整体好感度≈${jevAffinity.affinity.value ?? "未知"}${jevAffinity.boundaryApplied ? "（触发边界保护，锁 25 分）" : ""}`;
  }
  // 图片只在总览任务参与分析（逐句任务不重复传图，省 token）
  const images = input.task === "overview" ? (input.images ?? []).slice(0, 8) : [];
  if (images.length) user += imagePrompt(images);

  const { content, model, usage } = await chatCompletion(
    [
      { role: "system", content: system },
      images.length
        ? { role: "user", content: buildVisionContent(user, images) }
        : { role: "user", content: user },
    ],
    { json: true, signal, vision: images.length > 0, onUsage },
  );

  const parsed = extractJson(content);

  const output: AnalysisResponse = {
    revision: input.revision,
    contextHash,
    model,
    rubricVersion: RUBRIC,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    },
    latencyMs: Math.round(performance.now() - start),
    retrievalHits: (
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
      })),
  };

  if (input.task === "overview") {
    output.overview = toOverview(input, parsed);
    // 用 Jev 快速判定的好感度覆盖 GPT 的好感度（下一步指导仍以 GPT 为准）
    if (jevAffinity) {
      output.overview.affinity = jevAffinity.affinity;
      output.overview.affinityDimensions = jevAffinity.affinityDimensions;
      output.overview.affinityRawValue = jevAffinity.affinityRawValue;
      output.overview.boundaryApplied = jevAffinity.boundaryApplied;
    }
    if (images.length) {
      const insights = toImageInsights(parsed.image_insights, images);
      if (insights.length) output.imageInsights = insights;
    }
  } else output.lines = toLines(input, parsed);

  return output;
}

import type { Message, LineResult, AnalysisRequest } from "./types";
export const EVENT_KINDS = {
  boundary:
    "明确提出保持距离、只做朋友、拒绝追求或停止联系的边界，不是暂时忙碌",
  reopen: "明确撤回先前的拒绝、重新允许接近或说明先前拒绝只是误会",
  invitation: "提出具体邀约或相处计划",
  confirmation: "明确接受或确认此前的邀约、承诺或安排",
  cancellation: "明确取消、拒绝或改期已有的具体安排",
  care: "针对对方具体处境或需要提供关心、支持或帮助",
  preference: "明确说出个人偏好、忌讳或重要习惯",
  disclosure: "主动分享重要个人经历、真实感受或脆弱处境",
  commitment: "明确表达喜欢、爱意或关系承诺，不是普通夸奖",
  question: "向对方提出一个具体、尚待回应的问题",
  correction: "明确澄清、纠正或解释前面某句话的意思",
  none: "没有值得跨片段保留的明确事件，只有普通接话、模糊暗示或证据不够",
} as const;
export type MemoryEvent = {
  id: string;
  kind: keyof typeof EVENT_KINDS;
  confidence: number;
  status: "active" | "resolved" | "uncertain";
  resolvedBy?: string;
};
export type MemoryUpdate = {
  id: string;
  status: MemoryEvent["status"];
  evidenceId: string | null;
};
export function collectEvents(
  lines: Record<string, LineResult>,
  previous: Record<string, MemoryEvent>,
) {
  const events = { ...previous };
  for (const [id, line] of Object.entries(lines)) {
    if (!line.event) continue;
    if (line.event.kind === "none" || line.event.confidence < 0.65) {
      delete events[id];
      continue;
    }
    const old = events[id];
    events[id] = {
      id,
      kind: line.event.kind,
      confidence: line.event.confidence,
      status: old?.kind === line.event.kind ? old.status : "active",
      resolvedBy: old?.kind === line.event.kind ? old.resolvedBy : undefined,
    };
  }
  return events;
}
const terms = (text: string) => {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return new Set(
    Array.from({ length: Math.max(0, s.length - 1) }, (_, i) =>
      s.slice(i, i + 2),
    ),
  );
};
// Retrieval uses original language, not past scores or model probabilities as evidence.
export function relevantEvents(
  messages: Message[],
  events: Record<string, MemoryEvent>,
  query: Message[],
  cutoff = messages.length,
): MemoryEvent[] {
  const index = new Map(messages.map((m, i) => [m.id, i]));
  const queryIds = new Set(query.map((m) => m.id));
  const words = terms(
    query
      .slice(-20)
      .map((m) => m.text)
      .join(" "),
  );
  const ranked = Object.values(events)
    .filter(
      (e) => !queryIds.has(e.id) && (index.get(e.id) ?? Infinity) < cutoff,
    )
    .map((e) => {
      const i = index.get(e.id)!;
      const overlap = [...terms(messages[i].text)].filter((t) =>
        words.has(t),
      ).length;
      const important =
        ["boundary", "reopen", "commitment"].includes(e.kind) &&
        e.status !== "resolved";
      return {
        e,
        i,
        score:
          (important ? 100 : 0) +
          overlap * 5 +
          (["invitation", "confirmation", "cancellation"].includes(e.kind) &&
          e.status !== "resolved"
            ? 8
            : 0),
      };
    });
  return ranked
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, 12)
    .map((x) => x.e);
}
export function boundedContext(
  messages: Message[],
  start: number,
  end: number,
  events: Record<string, MemoryEvent> = {},
  causal = false,
) {
  // Recent originals get priority; historical originals share the same hard request budget.
  const recent: Message[] = [];
  let chars = 0;
  for (let i = end - 1; i >= start && recent.length < 100; i--) {
    const len = Array.from(messages[i].text).length;
    if (len > 12000) continue;
    if (chars + len > 8000 && recent.length) break;
    recent.unshift(messages[i]);
    chars += len;
  }
  const selected = relevantEvents(
    messages,
    events,
    recent,
    causal ? end : messages.length,
  );
  const index = new Map(messages.map((m, i) => [m.id, i]));
  const included = new Map(recent.map((m) => [m.id, m]));
  const memory: NonNullable<AnalysisRequest["memory"]> = [];
  for (const event of selected) {
    const at = index.get(event.id)!;
    const proof = event.resolvedBy ? index.get(event.resolvedBy) : undefined;
    // A later resolution must not leak into an earlier self reply.
    const resolvedVisible = proof !== undefined && (!causal || proof < end);
    const ids = [
      ...new Set([
        Math.max(0, at - 1),
        at,
        ...(resolvedVisible ? [proof!] : []),
      ]),
    ];
    const extra = ids
      .map((i) => messages[i])
      .filter((m) => !included.has(m.id));
    const extraChars = extra.reduce((n, m) => n + Array.from(m.text).length, 0);
    if (chars + extraChars > 12000 || included.size + extra.length > 500)
      continue;
    for (const m of extra) included.set(m.id, m);
    chars += extraChars;
    memory.push({
      id: event.id,
      kind: event.kind,
      status: resolvedVisible ? event.status : "active",
      resolvedBy: resolvedVisible ? event.resolvedBy : undefined,
    });
  }
  return {
    messages: [...included.values()].sort(
      (a, b) => index.get(a.id)! - index.get(b.id)!,
    ),
    memory,
  };
}

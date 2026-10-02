import { useRef, useState } from "react";
import { incrementalJobs, overviewJob } from "../shared/incremental";
import {
  collectEvents,
  boundedContext,
  type MemoryEvent,
} from "../shared/memory";
import {
  RUBRIC,
  requestContextKey,
  type Message,
  type Relation,
  type Overview,
  type LineResult,
  type AnalysisRequest,
  type AnalysisResponse,
  type AnalysisImage,
  type ImageInsight,
  type RetrievalHitRef,
} from "../shared/types";
import type { SavedConversation, Trend } from "./storage";
import { apiFetch } from "./api";
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
export function useAnalysis() {
  const [overview, setOverview] = useState<Overview | null>(null),
    [overviewFresh, setOverviewFresh] = useState(false),
    [lines, setLines] = useState<Record<string, LineResult>>({}),
    [events, setEvents] = useState<Record<string, MemoryEvent>>({}),
    [trend, setTrend] = useState<Trend[]>([]),
    [status, setStatus] = useState<"idle" | "loading" | "complete" | "error">(
      "idle",
    ),
    [error, setError] = useState(""),
    [progress, setProgress] = useState({ done: 0, total: 0 }),
    [latency, setLatency] = useState(0),
    [analyzedCount, setAnalyzedCount] = useState(0),
    [hits, setHits] = useState<RetrievalHitRef[]>([]),
    [imageInsights, setImageInsights] = useState<ImageInsight[]>([]);
  const rev = useRef(0),
    controller = useRef<AbortController | null>(null),
    base = useRef<{ messages: Message[]; relation: Relation } | null>(null),
    savedLines = useRef(lines),
    savedEvents = useRef(events),
    processed = useRef(0),
    profileIdRef = useRef<string | undefined>(undefined),
    imagesRef = useRef<AnalysisImage[] | undefined>(undefined);
  function cancel() {
    rev.current++;
    controller.current?.abort();
    setStatus("idle");
  }
  function reset() {
    cancel();
    base.current = null;
    // 切窗口/清空时一并清掉资料卡与图片引用，防止上一个窗口的档案串进新窗口分析
    profileIdRef.current = undefined;
    imagesRef.current = undefined;
    savedLines.current = {};
    savedEvents.current = {};
    processed.current = 0;
    setLines({});
    setEvents({});
    setTrend([]);
    setOverview(null);
    setOverviewFresh(false);
    setError("");
    setLatency(0);
    setAnalyzedCount(0);
    setHits([]);
    setImageInsights([]);
  }
  function restore(s: SavedConversation) {
    reset();
    base.current = { messages: s.messages, relation: s.relation };
    if (s.rubric !== RUBRIC) return;
    savedLines.current = s.lines;
    savedEvents.current = s.events;
    processed.current = s.analyzedCount;
    setLines(s.lines);
    setEvents(s.events);
    setTrend(s.trend);
    setOverview(s.overview);
    setOverviewFresh(s.completed);
    setAnalyzedCount(s.analyzedCount);
    setStatus(s.completed ? "complete" : "idle");
  }
  /** 执行单个分析 job，返回原始响应（不更新 state）。429/529 自动退避重试，最多 4 次。 */
  async function executeJob(
    job: AnalysisRequest,
    ctrl: AbortController,
    revision: number,
  ): Promise<AnalysisResponse> {
    if (profileIdRef.current) job.profileId = profileIdRef.current;
    // 图片消息只把文字描述送给模型，原图 dataUrl 不进请求（省带宽，模型不需要原图）
    job.messages = job.messages.map((m) =>
      m.kind === "image" ? { ...m, imageUrl: undefined } : m,
    );
    let data: AnalysisResponse | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await apiFetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
        signal: ctrl.signal,
      });
      if ([429, 529].includes(response.status) && attempt < 3) {
        await pause(
          Math.min(
            60000,
            Number(response.headers.get("retry-after") || 2 ** attempt) * 1000,
          ),
          ctrl.signal,
        );
        continue;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "分析失败");
      data = body;
      break;
    }
    if (!data || data.revision !== revision || data.rubricVersion !== RUBRIC)
      throw new Error("分析版本不匹配，请刷新重试");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(requestContextKey(job)),
    );
    const hash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== data.contextHash)
      throw new Error("分析上下文不匹配，请重试");
    return data;
  }

  /** 把单个 job 的结果合并进 state（lines/events/overview/hits/imageInsights）。 */
  function applyData(data: AnalysisResponse, revision: number) {
    if (rev.current !== revision) return;
    if (data.overview) setOverview(data.overview);
    if (data.imageInsights?.length) setImageInsights(data.imageInsights);
    if (data.retrievalHits?.length) {
      setHits((prev) => {
        const seen = new Set(prev.map((h) => h.id));
        return [...prev, ...data.retrievalHits!.filter((h) => !seen.has(h.id))];
      });
    }
    const added = Object.fromEntries(
      (data.lines ?? []).map((l) => [l.id, l]),
    );
    savedLines.current = { ...savedLines.current, ...added };
    savedEvents.current = collectEvents(added, savedEvents.current);
    for (const update of data.memoryUpdates ?? []) {
      const old = savedEvents.current[update.id];
      if (old)
        savedEvents.current[update.id] = {
          ...old,
          status: update.status,
          resolvedBy:
            update.status === "resolved"
              ? (update.evidenceId ?? undefined)
              : update.status === "uncertain"
                ? old.resolvedBy
                : undefined,
        };
    }
    setLines(savedLines.current);
    setEvents(savedEvents.current);
  }

  /** 好感度总览：单次 overview 调用，点击「分析好感度」触发（不再自动跑）。 */
  async function analyzeOverview(
    messages: Message[],
    relation: Relation,
    profileId?: string,
    images?: AnalysisImage[],
  ) {
    profileIdRef.current = profileId;
    // 只有总览 job 携带图片（逐句任务不重复传图）
    imagesRef.current = images?.length ? images.slice(0, 8) : undefined;
    if (!images?.length) setImageInsights([]);
    const revision = ++rev.current;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const started = performance.now();
    setStatus("loading");
    setError("");
    setOverviewFresh(false);
    setProgress({ done: 0, total: 1 });
    base.current = { messages, relation };
    const first = overviewJob(messages, relation, revision, savedEvents.current);
    if (!first.messages.length) {
      setStatus("error");
      setError("记录已保存，但没有可分析的文字。单条过长的消息请拆分。");
      return;
    }
    const withImages = (): Pick<AnalysisRequest, "images"> | {} =>
      imagesRef.current?.length ? { images: imagesRef.current } : {};
    try {
      const data = await executeJob(
        Object.assign(first, withImages()),
        ctrl,
        revision,
      );
      if (rev.current !== revision) return;
      applyData(data, revision);
      if (data.overview) {
        setLatency(Math.round(performance.now() - started));
        setOverviewFresh(true);
        setProgress({ done: 1, total: 1 });
        processed.current = messages.length;
        setAnalyzedCount(messages.length);
        setTrend((old) => {
          const point = {
            at: new Date().toISOString(),
            value: data.overview!.affinity.value,
            count: messages.length,
          };
          return old.at(-1)?.count === point.count
            ? [...old.slice(0, -1), point]
            : [...old, point];
        });
      }
      setStatus("complete");
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setError((e as Error).message);
        setStatus("error");
      }
    }
  }

  /** 逐条情绪/意向度分析：增量，只分析「未分析过」的消息，点击「分析每条情绪」触发。 */
  async function analyzeLines(
    messages: Message[],
    relation: Relation,
    profileId?: string,
  ) {
    profileIdRef.current = profileId;
    const revision = ++rev.current;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setStatus("loading");
    setError("");
    base.current = { messages, relation };
    // 标记超长消息为 skipped（不送入模型）
    for (const m of messages)
      if (m.kind === "text" && Array.from(m.text).length > 12000)
        savedLines.current = {
          ...savedLines.current,
          [m.id]: {
            id: m.id,
            skipped: "单条超过12,000字，已保存，请拆分后分析",
            score: {
              value: null,
              confidence: 0,
              status: "insufficient",
              probabilities: {},
            },
          },
        };
    setLines(savedLines.current);
    // changed=false：只对「还没有分析结果」的消息生成 job（增量，不重复分析历史）
    const jobs = incrementalJobs(
      messages,
      relation,
      revision,
      savedLines.current,
      savedEvents.current,
      false,
    );
    if (!jobs.length) {
      setStatus("complete");
      return;
    }
    let failed = 0;
    let done = 0;
    setProgress({ done: 0, total: jobs.length });
    async function safely(job: AnalysisRequest) {
      try {
        const data = await executeJob(job, ctrl, revision);
        if (rev.current === revision) applyData(data, revision);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          failed++;
          setError((e as Error).message);
        }
      } finally {
        if (rev.current === revision)
          setProgress((p) => ({ ...p, done: ++done }));
      }
    }
    async function worker() {
      while (jobs.length && rev.current === revision) {
        const job = jobs.shift()!;
        // 逐条情绪判断只需目标消息前后各约 20 条的上下文，不再带 80 条，大幅降 token
        const positions = job.targetIds.map((id) =>
          messages.findIndex((m) => m.id === id),
        );
        const firstTarget = Math.min(...positions),
          lastTarget = Math.max(...positions);
        const revised = boundedContext(
          messages,
          Math.max(0, firstTarget - 20),
          job.task === "self_message"
            ? lastTarget + 1
            : Math.min(messages.length, lastTarget + 21),
          savedEvents.current,
          job.task === "self_message",
        );
        if (job.memory?.some((e) => job.targetIds.includes(e.id)))
          await safely(job);
        else if (
          job.targetIds.every((id) => revised.messages.some((m) => m.id === id))
        )
          await safely({ ...job, ...revised });
        else await safely(job);
      }
    }
    await Promise.all([worker(), worker()]);
    if (rev.current !== revision) return;
    setStatus(failed ? "error" : "complete");
  }

  /** 兼容入口：先好感度总览，再逐条增量（等价旧的「一次全分析」）。 */
  async function run(
    messages: Message[],
    relation: Relation,
    profileId?: string,
    images?: AnalysisImage[],
  ) {
    await analyzeOverview(messages, relation, profileId, images);
    await analyzeLines(messages, relation, profileId);
  }
  return {
    overview,
    overviewFresh,
    lines,
    events,
    trend,
    status,
    error,
    clearError: () => setError(""),
    progress,
    latency,
    analyzedCount,
    hits,
    imageInsights,
    run,
    analyzeOverview,
    analyzeLines,
    cancel,
    reset,
    restore,
  };
}

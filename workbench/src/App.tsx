import { useVirtualizer } from "@tanstack/react-virtual";
import {
  loadConversationIndex,
  saveConversationIndex,
  loadConversationData,
  saveConversationData,
  setStorageScope,
  canClaimLegacyWorkspace,
  claimLegacyWorkspace,
  type ConversationMeta,
  type SavedConversation,
} from "./storage";
import { INTENTS, topIntents } from "../shared/intents";
import { REPLY_RATINGS, replyRating } from "../shared/ratings";
import { EMOTIONS, topEmotions } from "../shared/labels";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  Heart,
  MoreHorizontal,
  X,
  ArrowUpRight,
  MessageCircle,
  Settings2,
  Plus,
  ArrowRight,
  Send,
  Check,
  BookUser,
  FolderHeart,
  FolderOpen,
  MessagesSquare,
  ArrowLeftRight,
  Trash2,
  IdCard,
  ScanText,
  Coins,
  LogOut,
  Import,
} from "lucide-react";
import { parseChat, toMessages, mergeMessages } from "../shared/parser";
import ProfileBoard from "./ProfileBoard";
import Recharge from "./Recharge";
import VectorSub from "./VectorSub";
import ModelSettings from "./ModelSettings";
import ProfileSync from "./ProfileSync";
import ProfileImport from "./ProfileImport";
import OcrConfirm from "./OcrConfirm";
import ChatPanel, { type ChatMsg } from "./ChatPanel";
import {
  RUBRIC,
  ACTIONS,
  RELATIONS,
  statusLabel,
  meanQuality,
  type Message,
  type Relation,
  type Parsed,
  type AnalysisImage,
  type ImageInsight,
  type OcrChatResult,
} from "../shared/types";
import { exampleText } from "../shared/fixtures";
import { useAnalysis } from "./useAnalysis";
import {
  apiFetch,
  onCreditNotice,
  getUser,
  isLocalMode,
  type BalanceResp,
  type Pricing,
} from "./api";

function Modal({
  title,
  children,
  close,
  wide,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  /** 宽版弹窗（960px）：大浪指导等长内容阅读场景专用 */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),select,textarea,input",
          ) || [],
        );
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={wide ? "modal modal-wide" : "modal"}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="关闭" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
/** 单张图片压缩上限与每次分析附图上限 */
const IMG_MAX_EDGE = 1024;
const IMG_MAX_COUNT = 8;
const IMG_TYPES = /^image\/(jpeg|png|webp)$/;
/** 售后微信号（点击顶栏按钮复制） */
const SUPPORT_WX = "DLANG099";

let imgSeq = 0;
/**
 * 文件 → 压缩后的 AnalysisImage（最长边 ≤1024px、JPEG 0.82）。
 * 超过 8MB 或非图片返回 null。失败抛错由调用方提示。
 */
async function fileToAnalysisImage(file: File): Promise<AnalysisImage | null> {
  if (!IMG_TYPES.test(file.type) || file.size > 8 * 1024 * 1024) return null;
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("图片读取失败"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("图片解码失败"));
    im.src = raw;
  });
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  let out = raw;
  if (ctx) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    out = canvas.toDataURL("image/jpeg", 0.82);
  }
  imgSeq += 1;
  return {
    id: `img_${Date.now().toString(36)}_${imgSeq}`,
    name: file.name || `图片${imgSeq}`,
    dataUrl: out,
  };
}

export default function App({ onLogout }: { onLogout: () => void }) {
  const a = useAnalysis();
  const [credits, setCredits] = useState<number | null>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [showPricing, setShowPricing] = useState(false);
  const [showRecharge, setShowRecharge] = useState(false);
  const [showVectorSub, setShowVectorSub] = useState(false);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [creditNotice, setCreditNotice] = useState("");
  // 售后按钮（2026-10-02 主人定板「每个看板和首页加一个」）：点击复制微信号
  const [wxCopied, setWxCopied] = useState(false);
  const copyWx = () => {
    try {
      navigator.clipboard?.writeText(SUPPORT_WX);
    } catch {
      /* 剪贴板不可用时静默，按钮文案仍给出微信号 */
    }
    setWxCopied(true);
    window.setTimeout(() => setWxCopied(false), 1600);
  };
  const user = getUser();
  const [messages, setMessages] = useState<Message[]>([]),
    [input, setInput] = useState(""),
    [self, setSelf] = useState(""),
    [other, setOther] = useState("她"),
    [relation, setRelation] = useState<Relation>("crush");
  const [raw, setRaw] = useState(""),
    [parsed, setParsed] = useState<Parsed[]>([]),
    [role, setRole] = useState(""),
    [importing, setImporting] = useState(false),
    [settings, setSettings] = useState(false),
    [detail, setDetail] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  // 点击「好感度/下一步/我的发挥」但尚未分析时，弹窗询问用户是否分析（分析是显式扣费动作）
  const [askAnalyze, setAskAnalyze] = useState<null | "overview" | "lines">(null);
  const [overlap, setOverlap] = useState<Message[] | null>(null);
  const [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState("");
  // 本浏览器存在未隔离的旧会话数据（账号隔离上线前的遗留），提供一次性导入
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const [view, setView] = useState<"chat" | "profile">("chat");
  const [profileSync, setProfileSync] = useState(false);
  // 资料建档弹窗（社交平台截图 → AI 识别 → 建档）
  const [profileImport, setProfileImport] = useState(false);
  // 聊天记录 OCR 确认弹窗（截图/图片 + 文字 → 对话行 → 用户确认谁是谁 → 转文本导入）
  const [ocrOpen, setOcrOpen] = useState(false);
  // 混合粘贴（文字 + 图片同时存在）时一并带入确认窗的文字记录
  const [ocrInitialText, setOcrInitialText] = useState("");
  // 附给总览分析的图片（对方照片/朋友圈/资料页截图）：贴图即入列，随会话参与分析，不持久化
  const [attachedImages, setAttachedImages] = useState<AnalysisImage[]>([]);
  const [imgNotice, setImgNotice] = useState("");
  // 2026-09-30 自动图片识别录入：占位行+附图 → 对号入座逐张识别 → 行级替换 → 直接录入
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addImageFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const picked = list.filter((f) => IMG_TYPES.test(f.type));
    if (!picked.length) {
      setImgNotice("只支持 jpg / png / webp 图片");
      return;
    }
    const results: AnalysisImage[] = [];
    for (const f of picked) {
      try {
        const img = await fileToAnalysisImage(f);
        if (img) results.push(img);
      } catch {
        setImgNotice(`「${f.name}」处理失败，已跳过`);
      }
    }
    if (!results.length) return;
    setAttachedImages((prev) => {
      const room = IMG_MAX_COUNT - prev.length;
      if (room <= 0) {
        setImgNotice(`最多附 ${IMG_MAX_COUNT} 张图，先删掉几张再贴`);
        return prev;
      }
      if (results.length > room)
        setImgNotice(`最多附 ${IMG_MAX_COUNT} 张图，已保留前 ${room} 张`);
      else setImgNotice("");
      return [...prev, ...results.slice(0, room)];
    });
  }, []);
  const removeImage = (id: string) =>
    setAttachedImages((prev) => prev.filter((x) => x.id !== id));

  // 拉取积分余额（带 Bearer，401 由 apiFetch 统一处理）。
  const refreshBalance = useCallback(() => {
    (async () => {
      try {
        const r = await apiFetch("/api/credits/balance");
        if (r.ok) {
          const d = (await r.json()) as BalanceResp;
          setCredits(d.credits);
          setPricing(d.pricing);
        }
      } catch {
        /* 网络/服务端异常不阻塞工作台 */
      }
    })();
  }, []);
  useEffect(() => {
    refreshBalance();
    const onFocus = () => refreshBalance();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshBalance]);

  // 积分不足（402）提示。
  useEffect(() => {
    return onCreditNotice((msg) => {
      setCreditNotice(msg);
      window.setTimeout(() => setCreditNotice(""), 4000);
    });
  }, []);

  function logout() {
    onLogout();
  }

  const [matched, setMatched] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [focusProfileId, setFocusProfileId] = useState<string | null>(null);
  // 绑定模式：未绑定窗口点「读取档案库」进入，点选资料卡即绑定本窗口
  const [bindMode, setBindMode] = useState(false);
  // 绑定/建档后需要带卡重跑本窗口分析（bindProfile 置位，重跑 effect 消费）
  const rerunAfterBind = useRef(false);
  // 图片占位识别后，按「[图片]」出现顺序暂存的原图 dataUrl（toMessages 消费）
  const pendingImgUrls = useRef<string[]>([]);
  // 示例聊天导入不触发自动匹配/建档（避免给示例建垃圾卡）
  const demoImport = useRef(false);
  const [chatPanel, setChatPanel] = useState(false);
  const [chatAutoQ, setChatAutoQ] = useState<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 150,
    getItemKey: useCallback((i: number) => messages[i].id, [messages]),
    overscan: 8,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 100,
  });
  const [convList, setConvList] = useState<ConversationMeta[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  // 大浪指导对话线程：按会话窗口隔离，localStorage 持久化（关了再开还在）
  const [chatThreads, setChatThreads] = useState<
    Record<string, ChatMsg[]>
  >(() => {
    try {
      return JSON.parse(localStorage.getItem("dalang.chatThreads") ?? "{}");
    } catch {
      return {};
    }
  });
  const chatMsgs = (activeConvId && chatThreads[activeConvId]) || [];
  const setChatMsgs = (next: ChatMsg[]) => {
    if (!activeConvId) return;
    setChatThreads((prev) => {
      const updated = { ...prev, [activeConvId]: next };
      try {
        localStorage.setItem("dalang.chatThreads", JSON.stringify(updated));
      } catch {
        /* 空间不足时丢弃持久化，会话内仍可用 */
      }
      return updated;
    });
  };
  const applySaved = (saved: {
    messages: Message[];
    self: string;
    other: string;
    relation: Relation;
  }) => {
    setMessages(saved.messages);
    setSelf(saved.self);
    setOther(saved.other || "她");
    setRelation(saved.relation);
  };
  /** 一次性把本浏览器遗留的旧会话数据并入当前账号（用户手动点，防新账号误认领）。 */
  async function importLegacy() {
    try {
      const moved = await claimLegacyWorkspace();
      setLegacyAvailable(false);
      const idx = await loadConversationIndex();
      setConvList(idx.list);
      setActiveConvId(idx.activeId);
      if (idx.activeId) {
        const active = idx.list.find((c) => c.id === idx.activeId);
        if (active?.profileId)
          setMatched({
            id: active.profileId,
            name: active.profileName || "她",
          });
        const saved = await loadConversationData(idx.activeId).catch(
          () => undefined,
        );
        if (saved?.schema === 1) {
          applySaved(saved);
          a.restore(saved);
        }
      }
      setNotice(
        moved
          ? `已把本浏览器旧记录并入当前账号（${moved} 个会话窗口），旧数据不再对其他账号可见。`
          : "没有可导入的旧记录。",
      );
    } catch {
      setStorageError("旧记录导入失败，请重试。");
    }
  }
  useEffect(() => {
    let live = true;
    // 🔴 账号隔离（2026-09-27）：所有本地会话数据按登录邮箱分命名空间，
    // 必须在任何读写前设置——否则同浏览器换账号会读到上一个账号的聊天。
    setStorageScope(user?.email || "");
    canClaimLegacyWorkspace()
      .then((v) => {
        if (live) setLegacyAvailable(v);
      })
      .catch(() => {});
    loadConversationIndex()
      .then(async (idx) => {
        if (!live) return;
        setConvList(idx.list);
        setActiveConvId(idx.activeId);
        if (idx.activeId) {
          // 恢复本窗口绑定的资料卡（绑定一次永久生效）
          const active = idx.list.find((c) => c.id === idx.activeId);
          if (active?.profileId)
            setMatched({
              id: active.profileId,
              name: active.profileName || "她",
            });
          const saved = await loadConversationData(idx.activeId).catch(
            () => undefined,
          );
          if (live && saved?.schema === 1) {
            applySaved(saved);
            a.restore(saved);
          }
        }
        if (live) setReady(true);
      })
      .catch(() => {
        if (live) {
          setStorageError(
            "本机记录读取失败，请检查浏览器存储权限。为避免覆盖旧记录，暂不自动保存。",
          );
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pendingSave = useRef<SavedConversation | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    lastSavedMessages = useRef<Message[] | null>(null);
  const flushSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!activeConvId) return;
    void saveConversationData(activeConvId, pendingSave.current).catch(() =>
      setStorageError(
        "本机保存失败，可能存储空间不足。当前页面仍可使用，请勿刷新以免丢失未保存记录。",
      ),
    );
  };
  useEffect(() => {
    if (!ready || storageError || !activeConvId) return;
    pendingSave.current = messages.length
      ? {
          schema: 1,
          rubric: RUBRIC,
          messages,
          self,
          other,
          relation,
          lines: a.lines,
          events: a.events,
          overview: a.overview,
          trend: a.trend,
          analyzedCount: a.analyzedCount,
          completed: a.status === "complete",
        }
      : null;
    if (lastSavedMessages.current !== messages || a.status !== "loading") {
      lastSavedMessages.current = messages;
      flushSave();
    } else if (!saveTimer.current)
      saveTimer.current = setTimeout(flushSave, 750);
    // 会话索引（名字/关系）同步
    setConvList((prev) => {
      const exists = prev.some((c) => c.id === activeConvId);
      const next = exists
        ? prev.map((c) =>
            c.id === activeConvId
              ? {
                  ...c,
                  name: matched?.name || other || c.name,
                  relation,
                  updated: Date.now(),
                }
              : c,
          )
        : [
            ...prev,
            {
              id: activeConvId,
              name: matched?.name || other || "她",
              relation,
              updated: Date.now(),
            },
          ];
      void saveConversationIndex({ list: next, activeId: activeConvId });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    activeConvId,
    messages,
    self,
    other,
    relation,
    matched,
    a.lines,
    a.events,
    a.overview,
    a.trend,
    a.analyzedCount,
    a.status,
  ]);
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) flushSave();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);
  // 图片分析结论自动写入她的资料卡 photos（有绑定档案时，同一批结果只写一次）
  const syncedInsightsRef = useRef("");
  useEffect(() => {
    if (a.status !== "complete" || !matched || !a.imageInsights.length) return;
    const sig = a.imageInsights.map((i) => `${i.imageId}:${i.note}`).join("|");
    if (syncedInsightsRef.current === sig) return;
    let live = true;
    void (async () => {
      try {
        const r = await apiFetch(`/api/profile/${matched.id}`);
        if (!r.ok) return;
        const p = (await r.json()) as { photos?: unknown[] };
        const photos = Array.isArray(p.photos) ? p.photos : [];
        const additions = a.imageInsights.map((ins, i) => ({
          content: [
            `图${i + 1}`,
            ins.tags.length ? `穿搭/风格：${ins.tags.join("、")}` : "",
            ins.scene ? `场景：${ins.scene}` : "",
          ]
            .filter(Boolean)
            .join("；"),
          decode: [
            ins.authenticity ? `真实性：${ins.authenticity}` : "",
            ins.note || "",
          ]
            .filter(Boolean)
            .join("。"),
        }));
        const fresh = additions.filter(
          (x) =>
            !photos.some(
              (old) =>
                old &&
                typeof old === "object" &&
                (old as { content?: string }).content === x.content,
            ),
        );
        if (!fresh.length) {
          if (live) syncedInsightsRef.current = sig;
          return;
        }
        const pr = await apiFetch(`/api/profile/${matched.id}/patch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ photos: [...photos, ...fresh] }),
        });
        if (pr.ok && live) syncedInsightsRef.current = sig;
      } catch {
        /* 静默：图片入档失败不影响分析流程 */
      }
    })();
    return () => {
      live = false;
    };
  }, [a.status, a.imageInsights, matched]);
  // 资料卡绑定/建档后：自动结合档案整窗重跑（2026-10-02 起不分 local/SaaS，Jev 成本已可控）。
  useEffect(() => {
    if (!matched || !messages.length || !rerunAfterBind.current) return;
    rerunAfterBind.current = false;
    rerunAfterChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matched]);
  const stay = useRef(true);
  useEffect(() => {
    if (messages.length && stay.current)
      virtual.scrollToIndex(messages.length - 1, { align: "end" });
  }, [messages.length]);
  const busy = a.status === "loading",
    ov = a.overview,
    value = ov?.affinity.value,
    quality = meanQuality(messages, a.lines);
  const last = a.trend.at(-1),
    previous = a.trend.at(-2);
  const delta =
    a.status === "complete" && last?.value != null && previous?.value != null
      ? last.value - previous.value
      : null;
  function start(ms: Message[]) {
    setMessages(ms);
    setInput("");
    // 2026-10-02 主人定板「分析好感度和每条自动」：录入/追加后自动跑分析，
    // 不再分 local/SaaS——逐条情绪与好感度六维都走 Jev（便宜、快），自动分析成本可控；
    // SaaS 原先「不自动防烧积分」的设计作废（好感度/逐条的计费大头已切 Jev）。
    void a.run(ms, relation, matched?.id, attachedImages);
  }
  /** 结构变更（切归属/删除/换关系/交换身份/绑卡）后：整窗自动重跑（Jev 成本已可控）。 */
  function rerunAfterChange(ms: Message[] = messages, rel: Relation = relation) {
    a.reset();
    void a.run(ms, rel, matched?.id, attachedImages);
  }
  function add(ms: Message[], mode: "auto" | "append" | "skip" = "auto") {
    const m = mergeMessages(messages, ms, mode);
    if (m.ambiguous) {
      setOverlap(ms);
      return;
    }
    if (!m.added) {
      setNotice("已识别重复：这段与已录入的记录一致，未重复录入。");
      setInput("");
      return;
    }
    if (m.overlap > 0)
      setNotice(`已自动对齐：跳过 ${m.overlap} 条重合记录，新增 ${m.added} 条。`);
    else setNotice("");
    start(m.messages);
  }
  /**
   * 2026-09-30 自动图片识别录入：记录里的「[图片] 文件名」占位行 ↔ 附图对号入座
   * （文件名跨扩展名匹配优先，剩余按顺序补位），并发 2 逐张识别，行级替换占位行后
   * 直接走正常导入——图片和文字一起进上方看板，不再留在输入框附件区。
   * 单张识别失败保留原占位文件名，不中断整批。
   */
  async function autoOcrAndImport(text: string, imgs: AnalysisImage[]) {
    if (ocrBusy) {
      // 2026-09-30 修复：原来静默 return，用户重复粘贴时内容凭空消失
      setNotice("正在识别上一批图片，等它完成再录入（识别窗里有进度）。");
      return;
    }
    const lines = text.split(/\r?\n/);
    const ph: { lineIdx: number; name: string }[] = [];
    lines.forEach((l, i) => {
      const m = l.trim().match(/^\[图片\]\s*(.*)$/);
      if (m) ph.push({ lineIdx: i, name: m[1].trim() });
    });
    if (!ph.length) {
      // 2026-09-30 修复：文字里没有图片占位（如这次复制的记录没带 [图片] 行）——
      // 原来静默 return 把文字和图全丢了。降级：图保持挂附件区（混合粘贴已先挂），
      // 文字正常走导入，绝不静默丢内容。
      setInput(text);
      prepare(text, true);
      return;
    }
    const stripExt = (s: string) =>
      s.replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
    const used = new Set<string>();
    const bind = new Map<number, AnalysisImage>(); // 占位序号 → 图
    for (let k = 0; k < ph.length; k++) {
      if (!ph[k].name) continue;
      const b = stripExt(ph[k].name);
      const hit = imgs.find((img) => {
        if (used.has(img.id) || !img.name) return false;
        const a = stripExt(img.name);
        return (
          a === b ||
          (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a)))
        );
      });
      if (hit) {
        bind.set(k, hit);
        used.add(hit.id);
      }
    }
    const restK = ph.map((_, k) => k).filter((k) => !bind.has(k));
    const restImgs = imgs.filter((img) => !used.has(img.id));
    for (let n = 0; n < Math.min(restK.length, restImgs.length); n++) {
      bind.set(restK[n], restImgs[n]);
      used.add(restImgs[n].id);
    }
    if (!bind.size) {
      // 2026-09-30 修复：图对不上号也不再丢——文字照常录入（skipOcr 防递归），图留附件区
      setNotice(
        "记录里有图片占位但没对上附图（文件名不匹配）：文字已按原样录入，图片留在附件区可 Ctrl+Enter 读图分析。",
      );
      setInput(text);
      prepare(text, true);
      return;
    }
    setOcrBusy(true);
    setOcrProgress({ done: 0, total: bind.size });
    setNotice(`正在识别 ${bind.size} 张图片，按占位对号入座…`);
    const desc = new Map<number, string>();
    const queue = [...bind.entries()];
    let done = 0;
    async function worker() {
      while (queue.length) {
        const [k, img] = queue.shift()!;
        try {
          const r = await apiFetch("/api/vision/chat-ocr", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              images: [{ id: img.id, name: img.name, dataUrl: img.dataUrl }],
            }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || "图片识别失败");
          const res = d as OcrChatResult;
          const t = res.lines
            .map((l) => l.text || l.imageDesc || "")
            .filter(Boolean)
            .join("；");
          desc.set(k, t || ph[k].name);
        } catch {
          desc.set(k, ph[k].name); // 单张失败：保留原占位文件名
        }
        done += 1;
        setOcrProgress({ done, total: bind.size });
      }
    }
    await Promise.all([worker(), worker()]);
    setOcrBusy(false);
    setOcrProgress(null);
    // 行级替换 + 按 [图片] 出现顺序收集原图 dataUrl（给 toMessages 注入 imageUrl）
    const imgUrls: string[] = [];
    const finalText = lines
      .map((l, i) => {
        const k = ph.findIndex((x) => x.lineIdx === i);
        if (k < 0 || !desc.has(k)) return l;
        const d = desc.get(k)!;
        imgUrls.push(bind.get(k)?.dataUrl || "");
        // 函数式替换：描述里可能含 $ 等特殊字符，不能直接当替换串
        return l.replace(/(\[图片\])\s*.*$/, (_m, p1) => `${p1} ${d}`);
      })
      .join("\n");
    pendingImgUrls.current = imgUrls;
    // 图片已识别进记录，附件区清空；走正常导入（skipOcr 防止再次触发识别）
    setAttachedImages([]);
    setImgNotice("");
    setInput("");
    prepare(finalText, true);
  }

  function prepare(text: string, skipOcr = false) {
    if (ocrBusy) return;
    if (!text.trim()) return;
    if (text.length > 250000) {
      setNotice("这次粘贴超过25万字符，请分几次追加；历史记录不会被截断。");
      return;
    }
    const p = parseChat(text);
    // 2026-09-30：记录带「[图片] 文件名」占位且附了图 → 自动识别对号入座直接录入；
    // 没附图则给识别引导（不阻断录入）
    const phCount = p.messages.filter((m) => /^\[图片\]/.test(m.text.trim())).length;
    if (phCount && attachedImages.length && !skipOcr) {
      void autoOcrAndImport(text, attachedImages);
      return;
    }
    if (phCount && !attachedImages.length)
      setNotice(
        `记录里有 ${phCount} 个图片占位：把对应的图片文件拖进来（或点「加图」）再录入，会自动识别到对应位置；不识别也可直接录入。`,
      );
    const names = [...new Set(p.messages.map((x) => x.speaker))];
    if (
      messages.length &&
      self &&
      !p.warnings.length &&
      names.every((n) => n === self || n === other)
    ) {
      add(toMessages(p.messages, self, pendingImgUrls.current));
      pendingImgUrls.current = [];
      return;
    }
    setRaw(text);
    setParsed(p.messages);
    setRole(names.includes(self) ? self : names.includes("我") ? "我" : "");
    setImporting(true);
  }
  /**
   * 把档案卡里的历史聊天（timeline）合并进当前窗口：去重、"用户=我/她=对方"，
   * 返回合并后的完整消息数组（无新增返回 null）。
   */
  function mergeProfileTimeline(
    id: string,
    timeline: { t?: string; who?: string; text?: string }[],
  ): Message[] | null {
    const msgs: Message[] = timeline
      .filter((e) => e.text && e.text.trim())
      .map((e, i) => ({
        id: `pf-${id}-${i}`,
        sender: /用户|^我$/.test(e.who ?? "")
          ? ("self" as const)
          : ("other" as const),
        text: e.text!,
        timestamp: e.t ?? null,
        kind: "text" as const,
      }));
    if (!msgs.length) return null;
    const seen = new Set(messages.map((m) => `${m.text}|${m.timestamp ?? ""}`));
    const fresh = msgs.filter((m) => !seen.has(`${m.text}|${m.timestamp ?? ""}`));
    if (!fresh.length) return null;
    // 档案是历史脉络，合并到窗口最前面，保持其原始顺序
    return [...fresh, ...messages];
  }
  /** 把窗口绑定到资料卡：持久化到会话索引，之后不再重复匹配。 */
  function bindProfile(id: string, pname: string) {
    rerunAfterBind.current = true;
    setMatched({ id, name: pname });
    if (!activeConvId) return;
    setConvList((prev) => {
      const next = prev.map((c) =>
        c.id === activeConvId
          ? { ...c, profileId: id, profileName: pname }
          : c,
      );
      void saveConversationIndex({ list: next, activeId: activeConvId });
      return next;
    });
  }
  /** 未绑定时一键建档：用当前对方称呼新建资料卡并绑定本窗口。 */
  async function createAndBindProfile() {
    const pname = matched?.name || other;
    if (!messages.length || !pname || pname === "她") {
      setNotice("先粘贴聊天记录并确认对方称呼，再建档绑定。");
      return;
    }
    try {
      const id = await createProfileCard(pname);
      bindProfile(id, pname);
      setNotice(`已为「${pname}」新建资料卡并绑定本窗口。`);
      setFocusProfileId(id);
      setView("profile");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  /** 后端新建一张资料卡，返回 id。id 必须为「拼音_平台」小写下划线格式（与档案库 CLI 校验一致）。 */
  async function createProfileCard(pname: string): Promise<string> {
    const id = `u${Date.now().toString(36)}_wechat`;
    const resp = await apiFetch("/api/profile/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: pname, platform: "微信" }),
    });
    const d = await resp.json();
    if (!resp.ok) throw new Error(d.error || "建档失败");
    return d.id ?? id;
  }
  /**
   * 绑定模式：在档案库点选一张卡 → 绑定本窗口 + 把她档案里的历史聊天
   * 并入窗口（自动去重对齐），之后用户可继续粘贴录入。
   */
  async function bindFromArchive(id: string, pname: string) {
    bindProfile(id, pname);
    setOther(pname);
    setBindMode(false);
    setView("chat");
    try {
      const r = await apiFetch(`/api/profile/${id}`);
      const p = r.ok ? await r.json() : null;
      const tl: { t?: string; who?: string; text?: string }[] = p?.timeline ?? [];
      // 档案里有「用户/我」的发言 → 推断我的称呼，后续粘贴可走自动识别通道
      if (tl.some((e) => /用户|^我$/.test(e.who ?? ""))) setSelf("我");
      const merged = mergeProfileTimeline(id, tl);
      if (merged) {
        setMessages(merged);
        setNotice(
          `已绑定「${pname}」，她的历史聊天已并入窗口（自动去重对齐），直接粘贴新聊天即可追加。`,
        );
      } else {
        setNotice(
          `已绑定「${pname}」。档案历史与窗口记录已对齐、无新增，继续粘贴新聊天即可。`,
        );
      }
      // 带资料卡的综合分析由「绑定重跑」effect 统一触发，这里不再手动跑
    } catch {
      setNotice(`已绑定「${pname}」，档案历史读取失败，可继续粘贴新聊天。`);
    }
  }
  /** 绑定模式：库中没有 → 输入名字直接新建资料卡并绑定本窗口。 */
  async function createCardFromArchive(pname: string) {
    try {
      const id = await createProfileCard(pname);
      await bindFromArchive(id, pname);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  /**
   * 导入后按对方名字匹配库内资料卡：命中则 bindProfile 持久化绑定
   * （原来只 setMatched 存内存，切窗口/刷新就丢 = 「新建窗口绑定失败」的根因之一），
   * 并把档案历史聊天并入窗口；带卡重跑由绑定重跑 effect 统一处理。
   */
  function matchProfile(name: string) {
    if (!name.trim()) {
      setMatched(null);
      return;
    }
    apiFetch(`/api/profile/match?name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!(d.matched && d.id)) {
          setMatched(null);
          return;
        }
        bindProfile(d.id, name);
        apiFetch(`/api/profile/${d.id}`)
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (p: { timeline?: { t?: string; who?: string; text?: string }[] } | null) => {
              const merged = mergeProfileTimeline(d.id, p?.timeline ?? []);
              if (merged) setMessages(merged);
            },
          )
          .catch(() => undefined);
      })
      .catch(() => setMatched(null));
  }
  /**
   * 确认导入后调用：库里命中就绑定，没命中就自动建档并绑定本窗口。
   * 设计口径：一个对话窗口 = 一个对象 = 一张资料卡，且绑定持久化到会话索引。
   */
  async function matchOrCreateProfile(name: string) {
    const n = name.trim();
    if (!n || n === "她") {
      // 2026-09-30 修复：原来静默 return，用户完全无感知「为什么没建档」。
      // 典型场景：单说话人录入点「全是我说的」→ otherName 落为「她」。
      setNotice(
        "本次录入没有识别到对方的称呼，未自动建档；可在「聊天设置」里填对方称呼后点「绑定资料卡」。",
      );
      return;
    }
    try {
      const r = await apiFetch(`/api/profile/match?name=${encodeURIComponent(n)}`);
      const d = await r.json();
      if (d.matched && d.id) {
        matchProfile(n);
        return;
      }
    } catch {
      // 2026-09-30 修复：原来静默 return（「不阻塞录入」），用户只看到「没建档」不知原因。
      setNotice(
        "资料卡匹配服务暂时不可用，本次未自动建档；聊天已正常录入，可稍后点「绑定资料卡」重试。",
      );
      return; // 匹配服务异常时不阻塞聊天录入
    }
    try {
      const id = await createProfileCard(n);
      bindProfile(id, n);
      setNotice(
        `已为「${n}」自动建档并绑定本窗口（一个窗口一个对象），分析会结合她的资料卡。`,
      );
    } catch (e) {
      setNotice(
        `自动建档失败：${(e as Error).message}，可稍后点「存档到资料卡」手动建档。`,
      );
    }
  }
  function confirmImport(pickRole?: string) {
    const chosenRole = pickRole ?? role;
    const names = [...new Set(parsed.map((x) => x.speaker))];
    setSelf(chosenRole);
    const otherName = names.find((n) => n !== chosenRole) || "她";
    setOther(otherName);
    setImporting(false);
    add(toMessages(parsed, chosenRole, pendingImgUrls.current));
    pendingImgUrls.current = [];
    // 已手动绑定资料卡的窗口不再自动匹配，避免覆盖绑定；示例导入不建档；
    // 未绑定 → 先匹配库内卡，没命中就自动建档并绑定（一个窗口一个对象一张卡）
    if (!matched && !demoImport.current) void matchOrCreateProfile(otherName);
    demoImport.current = false;
  }
  /** 新建一个独立会话窗口（每个女生一个对象，数据隔离）。 */
  function newConversation() {
    flushSave();
    const id = `c${Date.now().toString(36)}`;
    const meta: ConversationMeta = {
      id,
      name: "新对象",
      relation,
      updated: Date.now(),
    };
    setConvList((prev) => {
      const next = [...prev, meta];
      void saveConversationIndex({ list: next, activeId: id });
      return next;
    });
    setActiveConvId(id);
    setBindMode(false);
    a.reset();
    setMessages([]);
    setInput("");
    setSelf("");
    setOther("她");
    setNotice("");
    setSettings(false);
    setDetail(null);
    setMatched(null);
    pendingSave.current = null;
    lastSavedMessages.current = null;
    stay.current = true;
    demoImport.current = false;
  }
  /** 切换会话窗口：保存当前 → 加载目标（含恢复其绑定的资料卡）。 */
  function switchConversation(id: string) {
    if (id === activeConvId) return;
    flushSave();
    setActiveConvId(id);
    setBindMode(false);
    a.reset();
    setDetail(null);
    setNotice(""); // 切窗口必须清提示，否则上一个窗口的「已绑定」残留误导本窗口（2026-09-25 真实事故）
    pendingSave.current = null;
    lastSavedMessages.current = null;
    const meta = convList.find((c) => c.id === id);
    setMatched(
      meta?.profileId
        ? { id: meta.profileId, name: meta.profileName || "她" }
        : null,
    );
    loadConversationData(id)
      .then((saved) => {
        if (saved?.schema === 1) {
          applySaved(saved);
          a.restore(saved);
        } else {
          setMessages([]);
          setSelf("");
          setOther("她");
        }
      })
      .catch(() => setStorageError("会话读取失败，请重试。"));
  }
  /** 删除会话窗口（含其全部聊天与分析数据）。 */
  function deleteConversation(id: string) {
    const rest = convList.filter((c) => c.id !== id);
    setConvList(rest);
    void saveConversationData(id, null);
    // 同步清掉该窗口的大浪指导记录
    setChatThreads((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      try {
        localStorage.setItem("dalang.chatThreads", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    if (id === activeConvId) {
      const nextId = rest[0]?.id ?? null;
      void saveConversationIndex({ list: rest, activeId: nextId });
      setActiveConvId(nextId);
      a.reset();
      pendingSave.current = null;
      lastSavedMessages.current = null;
      if (nextId) {
        loadConversationData(nextId)
          .then((saved) => {
            if (saved?.schema === 1) {
              applySaved(saved);
              a.restore(saved);
            } else {
              setMessages([]);
              setSelf("");
              setOther("她");
            }
            setMatched(null);
          })
          .catch(() => setStorageError("会话读取失败，请重试。"));
      } else {
        setMessages([]);
        setInput("");
        setSelf("");
        setOther("她");
        setMatched(null);
      }
      setDetail(null);
    } else {
      void saveConversationIndex({ list: rest, activeId: activeConvId });
    }
  }
  /** 单条消息切换归属（我 ↔ 她），改完清空旧分析结果，由用户重新点击分析。 */
  function flipSender(id: string) {
    const next = messages.map((m) =>
      m.id === id
        ? { ...m, sender: m.sender === "self" ? ("other" as const) : ("self" as const) }
        : m,
    );
    setMessages(next);
    rerunAfterChange(next);
  }
  /** 删除单条消息，删完清空旧分析结果，由用户重新点击分析。 */
  function removeMessage(id: string) {
    const next = messages.filter((m) => m.id !== id);
    setMessages(next);
    rerunAfterChange(next);
  }
  /** 清空当前窗口的聊天内容（窗口本身保留）。 */
  function clear() {
    a.reset();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingSave.current = null;
    if (activeConvId)
      void saveConversationData(activeConvId, null)
        .then(() => setStorageError(""))
        .catch(() => setStorageError("本机记录删除失败，请重试清空。"));
    setMessages([]);
    setInput("");
    setSelf("");
    setOther("她");
    setNotice("");
    setSettings(false);
    setDetail(null);
    setMatched(null);
  }
  const names = [...new Set(parsed.map((x) => x.speaker))];
  // 2026-09-27 录入方式自动识别：单说话人（含「未分配」）= 一键点选谁说的即录入；
  // 两个真实说话人 = 点选谁是「我」；≥3 个真实说话人才要求整理格式。「未分配」不再拦截。
  const realNames = names.filter((n) => n !== "未分配");
  const tooManySpeakers = realNames.length > 2;
  const singleSpeaker = names.length === 1;
  const chosen = messages.find((m) => m.id === detail),
    result = detail ? a.lines[detail] : undefined;
  return (
    <main className="app">
      <nav className="top-nav">
        <div className="top-nav-tabs">
          <button
            className={view === "chat" ? "active" : ""}
            onClick={() => {
              setBindMode(false);
              setView("chat");
            }}
          >
            <MessageCircle size={16} /> 聊天分析
          </button>
          <button
            className={view === "profile" ? "active" : ""}
            onClick={() => {
              setBindMode(false);
              setView("profile");
            }}
          >
            <FolderHeart size={16} /> 档案库
          </button>
        </div>
        <div className="top-nav-right">
          <button
            className="top-nav-support"
            onClick={copyWx}
            title="售后支持 · 点击复制微信号"
          >
            <MessageCircle size={16} />
            {wxCopied ? "已复制，去微信添加" : "售后加微信 DLANG099"}
          </button>
          {isLocalMode() ? (
            <button
              className="top-nav-credits"
              onClick={() => setShowModelSettings(true)}
              title="配置中转站 Key 与向量库 license"
            >
              <Settings2 size={16} />
              模型设置
            </button>
          ) : (
            <>
              <button
                className="top-nav-credits"
                onClick={() => setShowPricing(true)}
                title="查看积分余额与定价"
              >
                <Coins size={16} />
                {credits === null ? "积分…" : `${credits} 分`}
              </button>
              <button
                className="top-nav-logout"
                onClick={logout}
                title="退出登录"
                aria-label="退出登录"
              >
                <LogOut size={16} />
              </button>
            </>
          )}
        </div>
      </nav>
      {creditNotice && (
        <div className="credit-toast" role="alert">
          {creditNotice}
          <button className="credit-toast-close" onClick={() => setCreditNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="workspace">
        {view === "profile" ? (
          <ProfileBoard
            focusId={focusProfileId}
            bindMode={bindMode}
            boundId={matched?.id ?? null}
            onSelectCard={(id, name) => void bindFromArchive(id, name)}
            onCreateCard={(name) => void createCardFromArchive(name)}
          />
        ) : (
        <section className="wechat" aria-label="微信聊天">
          <nav className="chat-rail" aria-label="聊天工具">
            <div className="conv-list">
              {convList.map((c) => (
                <div
                  key={c.id}
                  className={`conv-item ${c.id === activeConvId ? "active" : ""}`}
                  title={c.name}
                  onClick={() => switchConversation(c.id)}
                >
                  <span className="conv-avatar">
                    {(matched?.id && c.id === activeConvId
                      ? matched.name
                      : c.name
                    ).slice(0, 1)}
                  </span>
                  <button
                    className="conv-close"
                    aria-label={`删除会话 ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(c.id);
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              <button
                className="conv-add"
                aria-label="新建会话窗口"
                title="新建会话窗口（每个女生一个独立对话）"
                onClick={newConversation}
              >
                <Plus size={18} />
              </button>
              {legacyAvailable && (
                <button
                  className="conv-add"
                  aria-label="导入本浏览器旧聊天记录"
                  title="检测到本浏览器有账号隔离前的旧聊天记录，点此并入当前账号名下（一次性，其他账号将不可见）"
                  onClick={() => void importLegacy()}
                >
                  <Import size={15} />
                </button>
              )}
            </div>
            <button
              className="rail-active"
              aria-label="滚动到最新聊天"
              onClick={() => {
                stay.current = true;
                if (messages.length)
                  virtual.scrollToIndex(messages.length - 1, { align: "end" });
              }}
            >
              <MessageCircle size={23} />
            </button>
            <button
              className="rail-settings"
              aria-label="聊天设置"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={22} />
            </button>
          </nav>
          <header className="chat-head">
            <div className="contact-title">
              <h2>
                {matched?.name || (messages.length ? other : "微信聊天")}
              </h2>
              <span>{RELATIONS[relation]}</span>
              {matched ? (
                <button
                  className="profile-chip"
                  title={`本窗口已绑定「${matched.name}」的资料卡，点击查看`}
                  onClick={() => {
                    setFocusProfileId(matched.id);
                    setView("profile");
                  }}
                >
                  <BookUser size={13} /> 资料卡 · {matched.name}
                </button>
              ) : (
                <button
                  className="profile-chip unbound"
                  title="把本窗口绑定到档案库的一张资料卡，分析会结合她的档案"
                  onClick={() => {
                    setBindMode(true);
                    setView("profile");
                  }}
                >
                  <BookUser size={13} /> 绑定资料卡
                </button>
              )}
            </div>
            <button
              className="header-affinity"
              onClick={() => {
                if (messages.length && !ov && !busy) setAskAnalyze("overview");
                else setDetail("overview");
              }}
              aria-label="查看好感度详情"
            >
              <span>好感度</span>
              <strong key={value} className="affinity-number">
                {value ?? "—"}
              </strong>
              {value != null && (
                <span className="affinity-hearts" aria-hidden="true">
                  <Heart className="affinity-heart heart-one" size={12} />
                  <Heart className="affinity-heart heart-two" size={9} />
                  <Heart className="affinity-heart heart-three" size={7} />
                </span>
              )}
              {delta != null && delta !== 0 && (
                <small>
                  {delta > 0 ? "+" : ""}
                  {delta}
                </small>
              )}
            </button>
            <div className="header-tools">
              <button
                className="icon"
                aria-label={
                  matched
                    ? `查看「${matched.name}」的资料卡`
                    : "未绑定资料卡：去档案库选一张卡绑定，她的历史聊天会并入本窗口"
                }
                title={
                  matched
                    ? `查看「${matched.name}」的资料卡`
                    : "未绑定资料卡：去档案库选一张卡绑定，她的历史聊天会并入本窗口"
                }
                onClick={() => {
                  if (matched) {
                    setBindMode(false);
                    setFocusProfileId(matched.id);
                    setView("profile");
                  } else {
                    // 未绑定也放行：进档案库绑定模式，点卡即绑定并拉取历史聊天
                    setBindMode(true);
                    setView("profile");
                  }
                }}
              >
                <FolderOpen size={20} />
              </button>
              <button
                className="icon"
                aria-label="存档到资料卡"
                title="存档到资料卡"
                onClick={() => setProfileSync(true)}
                disabled={!messages.length}
              >
                <BookUser size={20} />
              </button>
              <button
                className="icon"
                aria-label="新建会话窗口"
                title="新建会话窗口（每个女生一个独立对话）"
                onClick={newConversation}
              >
                <Plus size={20} />
              </button>
              <button
                className="icon"
                aria-label="更多聊天设置"
                onClick={() => setSettings(true)}
              >
                <MoreHorizontal size={24} />
              </button>
            </div>
          </header>
          <div
            ref={scroller}
            className="chat-scroll"
            onScroll={(e) => {
              const el = e.currentTarget;
              stay.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
          >
            {!messages.length ? (
              <div className="empty">
                <h2>{matched?.name ? `分析「${matched.name}」` : "新窗口 · 一个女生一个对象"}</h2>
                <div className="empty-steps">
                  <p>① 在微信里多选聊天，点「复制」</p>
                  <p>② 直接粘贴到下方输入框（Ctrl+V）</p>
                  <p>③ 带「名字：」自动识别说话人，自动匹配档案卡并分析</p>
                  {matched ? (
                    <p className="empty-hint">
                      ✓ 本窗口已绑定「{matched.name}」的资料卡，分析会结合她的档案；粘贴聊天即可开始
                    </p>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() => {
                        setBindMode(true);
                        setView("profile");
                      }}
                    >
                      绑定她的资料卡（选卡自动并入历史聊天）<ArrowUpRight size={16} />
                    </button>
                  )}
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    demoImport.current = true;
                    prepare(exampleText(0));
                  }}
                >
                  用一段示例试试 <ArrowUpRight size={16} />
                </button>
              </div>
            ) : (
              <div
                style={{
                  height: virtual.getTotalSize(),
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtual.getVirtualItems().map((row) => {
                  const i = row.index,
                    m = messages[i];
                  const r = a.lines[m.id];

                  return (
                    <div
                      key={m.id}
                      data-index={row.index}
                      ref={virtual.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${row.start}px)`,
                      }}
                      id={`message-${m.id}`}
                      className={`message ${m.sender}`}
                    >
                      {(i === 0 || m.timestamp !== messages[i - 1].timestamp) &&
                        m.timestamp && (
                          <div className="timestamp">
                            {m.timestamp.replace(/^\d{4}年/, "")}
                          </div>
                        )}
                      <div className="message-row">
                        <div
                          className={`avatar ${m.sender === "self" ? "mine" : ""}`}
                        >
                          {(m.sender === "self" ? self : other).slice(0, 1)}
                        </div>
                        <div className="message-content">
                          {m.kind === "image" && m.imageUrl ? (
                            <div className="bubble bubble-image">
                              <img
                                src={m.imageUrl}
                                alt={m.text || "图片消息"}
                                loading="lazy"
                                onClick={() => {
                                  const src = m.imageUrl;
                                  if (src) window.open(src, "_blank");
                                }}
                              />
                              {m.text && (
                                <div className="image-caption">
                                  {m.text.replace(/^\[图片\]\s*/, "")}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="bubble">{m.text}</div>
                          )}
                          <div className="msg-actions">
                            <button
                              className="msg-act"
                              title={
                                m.sender === "self" ? "改成对方发的" : "改成我发的"
                              }
                              onClick={() => flipSender(m.id)}
                            >
                              <ArrowLeftRight size={13} />
                            </button>
                            <button
                              className="msg-act danger"
                              title="删除这条消息"
                              onClick={() => removeMessage(m.id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          {m.kind === "text" && (
                            <div className={`message-tags ${m.sender}`}>
                              {r?.skipped ? (
                                <span className="pending-tag">{r.skipped}</span>
                              ) : m.sender === "other" ? (
                                <>
                                  <div className="analysis-row emotion-row">
                                    <span className="analysis-row-label">
                                      情绪
                                    </span>
                                    {r?.emotions ? (
                                      topEmotions(r.emotions).map((emotion) => (
                                        <button
                                          key={emotion.key}
                                          className={`emotion-tag emotion-${emotion.key}`}
                                          onClick={() => setDetail(m.id)}
                                          aria-label={`${emotion.label} ${emotion.percent}，查看情绪分析：${m.text}`}
                                        >
                                          <span>{emotion.label}</span>
                                          <b>{emotion.percent}</b>
                                        </button>
                                      ))
                                    ) : (
                                      <button
                                        className="pending-tag"
                                        disabled={busy}
                                        onClick={() =>
                                          a.analyzeLines(messages, relation, matched?.id)
                                        }
                                      >
                                        {busy ? "分析中" : "分析情绪"}
                                      </button>
                                    )}
                                  </div>
                                  <div className="analysis-row intent-row">
                                    <span className="analysis-row-label">
                                      意图
                                    </span>
                                    {r?.intents ? (
                                      topIntents(r.intents).map((intent) => (
                                        <button
                                          key={intent.key}
                                          className="intent-tag"
                                          onClick={() => setDetail(m.id)}
                                          aria-label={`${intent.label} ${intent.percent}，查看意图分析：${m.text}`}
                                        >
                                          <span>{intent.label}</span>
                                          <b>{intent.percent}</b>
                                        </button>
                                      ))
                                    ) : (
                                      <button
                                        className="pending-tag"
                                        disabled={busy}
                                        onClick={() =>
                                          a.analyzeLines(messages, relation, matched?.id)
                                        }
                                      >
                                        {busy ? "分析中" : "分析意图"}
                                      </button>
                                    )}
                                  </div>
                                </>
                              ) : r ? (
                                <button
                                  className="reply-tag"
                                  onClick={() => setDetail(m.id)}
                                  aria-label={`查看回复评价：${m.text}`}
                                >
                                  <span>回复评级：</span>
                                  <b>
                                    {replyRating(r.score.value)?.label ??
                                      "待判断"}
                                  </b>
                                </button>
                              ) : (
                                <button
                                  className="pending-tag"
                                  disabled={busy}
                                  onClick={() => a.analyzeLines(messages, relation, matched?.id)}
                                >
                                  {busy ? "分析中" : "评价回复"}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="chat-insights">
            <button
              className="reply-summary"
              onClick={() => {
                if (messages.length && quality == null && !busy) setAskAnalyze("lines");
                else setDetail("performance");
              }}
            >
              <span>我的发挥</span>
              <strong>{replyRating(quality)?.label ?? "—"}</strong>
              {quality != null && <span>{quality}分</span>}
            </button>
            <span className="insight-divider" />
            <button
              className="action-summary"
              onClick={() => {
                if (messages.length && !ov && !busy) setAskAnalyze("overview");
                else setDetail("action");
              }}
            >
              <span>下一步</span>
              <strong>{ov ? ACTIONS[ov.action]?.label : messages.length ? "点击分析" : "等你导入聊天"}</strong>
              <ArrowRight size={14} />
            </button>
            <span className="insight-divider" />
            <button
              className="insight-cta"
              title={
                !messages.length
                  ? "先粘贴聊天记录"
                  : !matched
                    ? "大浪指导必须基于她的资料卡，请先绑定（导入聊天会自动建档）"
                    : "大浪指导：恋爱之神云端库 + 她的资料卡 + 已有分析结论，综合推进。对话记录按窗口保存"
              }
              disabled={!messages.length || !matched}
              onClick={() => setChatPanel(true)}
            >
              <MessagesSquare size={14} /> 大浪指导
            </button>
          </div>
          <div className="composer">
            {attachedImages.length > 0 && (
              <div className="img-strip" aria-label="附带图片">
                {attachedImages.map((img) => (
                  <figure key={img.id} className="img-thumb">
                    <img src={img.dataUrl} alt={img.name || "附带图片"} />
                    <button
                      className="img-remove"
                      aria-label={`删除 ${img.name || "图片"}`}
                      onClick={() => removeImage(img.id)}
                    >
                      <X size={12} />
                    </button>
                  </figure>
                ))}
                {imgNotice && <span className="img-notice">{imgNotice}</span>}
              </div>
            )}
            <textarea
              aria-label="粘贴聊天记录"
              disabled={!ready}
              placeholder={
                messages.length
                  ? `继续粘贴「${matched?.name || other}」的新聊天（微信复制 / 社交平台截图直接贴，自动识别），合并重复记录；也可直接贴她的照片/朋友圈截图一起分析（Ctrl+Enter 提交）`
                  : "粘贴聊天记录：微信复制文字直接贴；探探/积目/SOUL/抖音/小红书等平台截图直接贴，自动转成对话；也可贴照片/朋友圈截图一起分析"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={async (e) => {
                const imgs = Array.from(e.clipboardData.files).filter((f) =>
                  IMG_TYPES.test(f.type),
                );
                const t = e.clipboardData.getData("text");
                const hasText = t.trim().length > 0;
                // 混合粘贴：文字 + 图片一起存在 → 都收进来
                if (imgs.length && hasText) {
                  e.preventDefault();
                  // 2026-09-30：文字含「[图片]」占位 → 剪贴板里的图片直接转档进自动识别，
                  // 对号入座后连文字一起录入看板（不挂附件区、不弹确认窗）
                  if (/\[图片\]/.test(t)) {
                    const converted = (
                      await Promise.all(
                        imgs.slice(0, IMG_MAX_COUNT).map((f) => fileToAnalysisImage(f)),
                      )
                    ).filter(Boolean) as AnalysisImage[];
                    if (converted.length) {
                      setInput("");
                      await autoOcrAndImport(t, converted);
                      return;
                    }
                  }
                  void addImageFiles(imgs);
                  // 文字若已是聊天记录格式（微信多选复制：名字行 + 日期时间行 + 内容），
                  // 直接按聊天导入，图片只作分析附件；自由文字 + 图才走 OCR 确认窗
                  if (/\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/.test(t)) {
                    setInput(t);
                    prepare(t);
                    setNotice(
                      `已按聊天记录导入文字；${imgs.length} 张图已挂为附件，可 Ctrl+Enter 一起读图分析。`,
                    );
                  } else {
                    setOcrInitialText(t);
                    setOcrOpen(true);
                  }
                  return;
                }
                if (imgs.length) {
                  e.preventDefault();
                  await addImageFiles(imgs);
                  // 🔴 微信多选复制的文字是「延迟渲染」进剪贴板的（2026-09-26 本机剪贴板
                  // 探针实锤：CF_UNICODETEXT 已登记但 GlobalSize=0，数据要等粘贴目标
                  // 现场要才有）——记事本粘贴会触发微信渲染，浏览器粘贴事件瞬间去要
                  // 经常拿到空 → 表现为「只剩图片没文字」。所以这里异步补读剪贴板，
                  // 把迟到的文字抓回来；抓不到才提示正确姿势。
                  void (async () => {
                    let late = "";
                    for (let i = 0; i < 3 && !late.trim(); i++) {
                      if (i > 0) await new Promise((r) => setTimeout(r, 300));
                      try {
                        late = (await navigator.clipboard.readText()) || "";
                      } catch {
                        break; // 无权限/非安全上下文：放弃补抓，走下方提示
                      }
                    }
                    if (late.trim()) {
                      if (/\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/.test(late)) {
                        setInput(late);
                        prepare(late);
                        setNotice(
                          "剪贴板文字是延迟送达的，已自动补抓并按聊天记录导入；图片已挂为附件，可 Ctrl+Enter 一起读图分析。",
                        );
                      } else {
                        setInput(late);
                        setNotice("已把剪贴板里迟到的文字填进输入框，Ctrl+Enter 提交即可。");
                      }
                      return;
                    }
                    // 纯图粘贴：剪贴板里没有文字——大概率是社交平台（探探/积目/SOUL/抖音/
                    // 小红书等手机 APP 无多选复制）的聊天截图，直接自动进截图转对话识别，
                    // 确认谁是谁后即可录入分析；想挂附件读图就关掉识别窗再 Ctrl+Enter
                    setOcrOpen(true);
                    setNotice(
                      `已贴入 ${imgs.length} 张截图，正在识别成对话（探探/积目/SOUL/抖音等平台截图都能读）；确认谁是谁后即可录入。想挂图做分析附件就关掉识别窗再 Ctrl+Enter。⚠ 微信语音复制不出来：先长按语音「转文字」再贴。`,
                    );
                  })();
                  return;
                }
                if (hasText) {
                  e.preventDefault();
                  setInput(t);
                  prepare(t);
                }
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  prepare(input);
                }
              }}
            />
            <div className="composer-bottom">
              <div className="composer-feedback">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  hidden
                  onChange={async (e) => {
                    const files = e.target.files;
                    if (files?.length) {
                      // 🔴 2026-10-01 主人定板：这个入口改名「截图转对话」，只用于聊天截图→
                      // 对话记录。选中图片后直接进 OCR 确认窗（不再叫「加图」两步走）。
                      await addImageFiles(files);
                      setOcrInitialText(input);
                      setOcrOpen(true);
                    }
                    e.target.value = "";
                  }}
                />
                <button
                  className="icon-add-img"
                  title="截图转对话：选择聊天记录截图（微信/探探/积目/SOUL/抖音等），自动转成文字对话录入，确认后参与分析"
                  disabled={!ready || attachedImages.length >= IMG_MAX_COUNT}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ScanText size={15} />
                  截图转对话
                  {attachedImages.length ? ` ${attachedImages.length}/${IMG_MAX_COUNT}` : ""}
                </button>
                <button
                  className="icon-add-img profile-import-cta"
                  title="更新资料：录入她的朋友圈 / 公域资料（抖音/探探/小红书等截图），AI 读取后自动更新她绑定的资料卡；公域和微信名字不同时，在弹窗里填「身份说明」防止更错卡"
                  disabled={!ready}
                  onClick={() => setProfileImport(true)}
                >
                  <IdCard size={15} />
                  更新资料
                </button>
                <span role="status">{storageError || notice}</span>{" "}
                <div className="analysis-status" aria-live="polite">
                  {busy ? (
                    <>
                      <span className="working" />
                      正在分析 {a.progress.done}/{a.progress.total}
                      <button onClick={a.cancel}>停止</button>
                    </>
                  ) : messages.length ? (
                    <>
                      <button
                        className="analyze-trigger"
                        title="只跑一次总览：输出好感度分数 + 下一步动作 + 话术，不逐条读情绪"
                        onClick={() =>
                          a.analyzeOverview(messages, relation, matched?.id, attachedImages)
                        }
                      >
                        <Heart size={14} />
                        分析好感度
                      </button>
                      <button
                        className="analyze-trigger"
                        title="逐条分析每条消息的情绪与意向度，只读尚未分析过的记录（增量，不重复烧分）"
                        onClick={() => a.analyzeLines(messages, relation, matched?.id)}
                      >
                        <MessageCircle size={14} />
                        分析每条情绪
                      </button>
                      {a.status === "complete" && (
                        <span className="completed">
                          <Check size={14} />
                          已分析
                          <button onClick={() => setDetail("overview")}>娱乐参考</button>
                        </span>
                      )}
                    </>
                  ) : null}
                </div>
                {a.error && <span className="error">{a.error}</span>}
              </div>
              {ocrProgress && (
                <span className="ocr-progress">
                  识别图片 {ocrProgress.done}/{ocrProgress.total}
                </span>
              )}
              <button
                className="send"
                disabled={!input.trim() || ocrBusy}
                onClick={() => prepare(input)}
              >
                <Send size={15} />
                {ocrBusy ? "识别中…" : messages.length ? "追加" : "录入"}
              </button>
            </div>
          </div>
        </section>
        )}
      </div>
      {askAnalyze && (
        <Modal title="还没分析，要现在分析吗？" close={() => setAskAnalyze(null)}>
          <p className="ms-hint">
            {askAnalyze === "overview"
              ? "还没有分析好感度。分析一次 = 单次总览调用，输出好感度分数 + 下一步动作 + 下一句话术，会消耗少量积分。"
              : "还有聊天记录没逐条分析过。只读取尚未分析过的记录（增量，不重复扣费），分析每条消息的情绪与意向度，会消耗积分。"}
          </p>
          <div className="role-options">
            {(() => {
              const kind = askAnalyze;
              return (
                <>
                  <button
                    className="primary"
                    onClick={() => {
                      setAskAnalyze(null);
                      if (kind === "overview")
                        a.analyzeOverview(messages, relation, matched?.id, attachedImages);
                      else a.analyzeLines(messages, relation, matched?.id);
                    }}
                  >
                    {kind === "overview" ? "分析好感度" : "分析每条情绪"}
                  </button>
                  <button onClick={() => setAskAnalyze(null)}>先不分析</button>
                </>
              );
            })()}
          </div>
        </Modal>
      )}
      {importing && (
        <Modal title="这段聊天里谁是你？" close={() => setImporting(false)}>
          <p className="ms-hint">
            带名字的多条记录已自动识别双方，点一下<b>哪个名字是你</b>即可；只有一条/单方内容时，点「谁说的」立即录入。录入后自动分析（好感度 + 每条情绪），无需手动点按钮；按钮仅用于重新分析。
          </p>
          <div className="role-options">
            {singleSpeaker ? (
              <>
                <button
                  onClick={() => {
                    setRole(names[0]);
                    confirmImport(names[0]);
                  }}
                >
                  全是我说的（都是你发的）
                </button>
                <button
                  onClick={() => {
                    setRole("__self_absent__");
                    confirmImport("__self_absent__");
                  }}
                >
                  全是对方说的（没有我）
                </button>
              </>
            ) : (
              realNames.map((n) => (
                <button
                  className={role === n ? "selected" : ""}
                  key={n}
                  onClick={() => setRole(n)}
                >
                  {n} ＝ 我
                </button>
              ))
            )}
          </div>
          <label className="field">
            识别到 {parsed.length} 条聊天
            <textarea
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setParsed(parseChat(e.target.value).messages);
              }}
            />
          </label>
          {tooManySpeakers && (
            <p className="error">
              识别到 {realNames.length} 个说话人，请保留两个人的聊天，可改成「我：内容」「对方：内容」。
            </p>
          )}
          {!singleSpeaker && (
            <button
              className="primary"
              disabled={
                !role ||
                !parsed.length ||
                tooManySpeakers ||
                (!names.includes(role) && role !== "__self_absent__")
              }
              onClick={() => confirmImport()}
            >
              录入
            </button>
          )}
        </Modal>
      )}
      {settings && (
        <Modal title="聊天设置" close={() => setSettings(false)}>
          <label className="field">
            你们的关系
            <select
              value={relation}
              onChange={(e) => {
                const r = e.target.value as Relation;
                setRelation(r);
                if (messages.length) rerunAfterChange(messages, r);
              }}
            >
              {Object.entries(RELATIONS).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            disabled={!messages.length}
            onClick={() => {
              const ms = messages.map((m) => ({
                ...m,
                sender:
                  m.sender === "self" ? ("other" as const) : ("self" as const),
              }));
              setSelf(other);
              setOther(self === "__self_absent__" ? "我" : self);
              setMessages(ms);
              rerunAfterChange(ms);
              setSettings(false);
            }}
          >
            交换双方身份
          </button>
          <button className="secondary danger" onClick={clear}>
            清空聊天，重新开始
          </button>
          <p>
            已保存 {messages.length.toLocaleString()}{" "}
            条聊天。记录保存在本机浏览器，刷新后可继续；分析时只发送所需片段给模型服务。清空会删除本机记录。
          </p>
        </Modal>
      )}
      {showModelSettings && (
        <Modal title="模型设置" close={() => setShowModelSettings(false)}>
          <ModelSettings close={() => setShowModelSettings(false)} />
        </Modal>
      )}
      {showPricing && (
        <Modal title="积分与定价" close={() => setShowPricing(false)}>
          <div className="pricing">
            <div className="pricing-balance">
              <span>当前积分余额</span>
              <strong>{credits === null ? "加载中…" : `${credits} 分`}</strong>
            </div>
            {user && <p className="pricing-account">账号：{user.email}</p>}
            <h3>计费单价（按每千 tokens）</h3>
            <ul className="pricing-list">
              <li>
                <span>输入（命中缓存前）</span>
                <strong>
                  {pricing ? pricing.inputPerK : 1.9} 分 / K
                </strong>
              </li>
              <li>
                <span>输入（命中缓存后）</span>
                <strong>
                  {pricing ? pricing.cachePerK : 0.23} 分 / K
                </strong>
              </li>
              <li>
                <span>输出</span>
                <strong>{pricing ? pricing.outputPerK : 9} 分 / K</strong>
              </li>
            </ul>
            <p className="pricing-note">
              余额不足时接口会返回 402，并提示「积分不足，请充值」。
            </p>
            <div className="pricing-actions">
              <button
                className="primary"
                onClick={() => {
                  setShowPricing(false);
                  setShowRecharge(true);
                }}
              >
                立即充值
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setShowPricing(false);
                  setShowVectorSub(true);
                }}
              >
                向量库订阅
              </button>
              <button className="secondary" onClick={() => setShowPricing(false)}>
                知道了
              </button>
            </div>
          </div>
        </Modal>
      )}
      {showRecharge && (
        <Modal title="积分充值" close={() => setShowRecharge(false)}>
          <Recharge
            close={() => setShowRecharge(false)}
            onCredits={(c) => setCredits(c)}
          />
        </Modal>
      )}
      {showVectorSub && (
        <Modal title="向量库订阅 · 大浪知识库" close={() => setShowVectorSub(false)}>
          <VectorSub close={() => setShowVectorSub(false)} />
        </Modal>
      )}
      {profileSync && (
        <Modal title="存档聊天记录 · 到她的档案" close={() => setProfileSync(false)}>
          <ProfileSync
            other={other}
            messages={messages}
            overview={a.overview}
            close={() => setProfileSync(false)}
            onBound={(id, name) => {
              // 绑定后由「绑定重跑」effect 统一带卡重跑分析
              bindProfile(id, name);
            }}
          />
        </Modal>
      )}
      {profileImport && (
        <Modal
          title="资料建档 · 导入她的社交平台资料"
          close={() => setProfileImport(false)}
        >
          <ProfileImport
            boundProfile={matched}
            close={() => setProfileImport(false)}
            onSaved={(id, name, mode) => {
              setProfileImport(false);
              if (mode === "new") {
                bindProfile(id, name);
                setOther(name);
                setNotice(`已为「${name}」建档并绑定本窗口，之后分析聊天会自动结合她的资料。`);
              } else if (mode === "match") {
                bindProfile(id, name);
                setOther(name);
                setNotice(`已把资料合并进「${name}」的已有档案（跨平台同一个人），并绑定本窗口。`);
              } else {
                setNotice(`已把资料截图内容更新到「${name}」的档案。`);
              }
            }}
          />
        </Modal>
      )}
      {ocrOpen && attachedImages.length > 0 && (
        <Modal title="聊天记录确认 · 谁是自己" close={() => setOcrOpen(false)}>
          <OcrConfirm
            images={attachedImages}
            initialText={ocrInitialText}
            defaultOther={matched?.name || other}
            close={() => {
              setOcrOpen(false);
              setOcrInitialText("");
            }}
            onConfirm={(text, otherName) => {
              setOcrOpen(false);
              setOcrInitialText("");
              // 截图/图片已转成文字记录（含图片内容描述），图片不再随分析传图
              setAttachedImages([]);
              setImgNotice("");
              setOther(otherName);
              prepare(text);
            }}
          />
        </Modal>
      )}
      {chatPanel && (
        <Modal
          wide
          title={matched ? `大浪指导 · ${matched.name}` : "大浪指导"}
          close={() => {
            setChatPanel(false);
            setChatAutoQ(undefined);
          }}
        >
          <ChatPanel
            close={() => {
              setChatPanel(false);
              setChatAutoQ(undefined);
            }}
            profileId={matched?.id}
            profileName={matched?.name}
            chatLog={messages
              .slice(-40)
              .map(
                (m) =>
                  `${m.timestamp ? `[${m.timestamp}] ` : ""}${
                    m.sender === "self" ? "我" : other
                  }: ${m.text}`,
              )
              .join("\n")}
            relation={relation}
            analysisSummary={
              a.overview
                ? [
                    `好感度：${a.overview.affinity.value ?? "未知"} 分（确定度 ${Math.round(a.overview.affinity.confidence * 100)}%）`,
                    `关系阶段：${a.overview.stage}｜下一步动作：${a.overview.action}`,
                    a.overview.affinityRawValue != null
                      ? `六维原始分：${a.overview.affinityRawValue}${a.overview.boundaryApplied ? "（触发边界保护，锁定 25 分）" : ""}`
                      : "",
                    a.overview.nextReply
                      ? `已建议下一句：${a.overview.nextReply}`
                      : "",
                    a.overview.risks?.length
                      ? `风险：${a.overview.risks.join("；")}`
                      : "",
                    a.overview.note ?? "",
                  ]
                  .filter(Boolean)
                  .join("\n")
                : undefined
            }
            msgs={chatMsgs}
            setMsgs={setChatMsgs}
            autoQuestion={chatAutoQ}
          />
        </Modal>
      )}
      {detail === "clear" && (
        <Modal title="清空当前窗口？" close={() => setDetail(null)}>
          <p>
            清空「{matched?.name || other}」窗口的聊天和分析（会话窗口保留，可在左侧继续切换其他对象）。
          </p>
          <button className="primary" onClick={clear}>
            清空聊天
          </button>
          <button className="secondary" onClick={() => setDetail(null)}>
            保留当前聊天
          </button>
        </Modal>
      )}
      {detail && detail !== "clear" && (
        <Modal
          title={
            detail === "overview"
              ? "好感度"
              : detail === "action"
                ? "下一步"
                : detail === "performance"
                  ? "我的发挥"
                  : chosen?.sender === "other"
                    ? "情绪与意图"
                    : "回复评价"
          }
          close={() => setDetail(null)}
        >
          {detail === "overview" ? (
            <>
              <p>
                0—100 是模型对这段聊天的好感信号评分，不是「对方喜欢你的概率」。
              </p>
              <p>
                根据近期对话和相关历史原话评分，旧分数不参与计算。证据少时仍保留分数供娱乐参考。
              </p>
              {!!ov?.memoryEvidenceIds?.length && (
                <details>
                  <summary>参考的历史原话</summary>
                  {[...new Set(ov.memoryEvidenceIds)].map((id) => {
                    const m = messages.find((m) => m.id === id);
                    return m ? (
                      <blockquote key={id}>
                        {m.sender === "self" ? self : other}：{m.text}
                      </blockquote>
                    ) : null;
                  })}
                </details>
              )}
              {ov?.affinityDimensions && (
                <div className="affinity-breakdown">
                  {ov.affinityDimensions.map((d) => (
                    <div key={d.key}>
                      <span>{d.label}</span>
                      <meter
                        min="0"
                        max="100"
                        value={d.judgment.value ?? 0}
                        aria-label={`${d.label} ${d.judgment.value} 分`}
                      />
                      <strong>{d.judgment.value}</strong>
                      <small>
                        占 {d.weight}% · {statusLabel(d.judgment)}
                      </small>
                    </div>
                  ))}
                </div>
              )}
              {ov?.boundaryApplied && (
                <p>
                  对方表达了明确且仍有效的拒绝边界。综合原分{" "}
                  {ov.affinityRawValue}，最终好感度最多显示 25 分。
                </p>
              )}
              {ov && (
                <p>
                  本轮判断：{statusLabel(ov.affinity)}。综合确定度{" "}
                  {Math.round(ov.affinity.confidence * 100)}%。
                </p>
              )}
              {a.imageInsights.length > 0 && (
                <div className="image-insights">
                  <h3 className="next-reply-heading">图片分析（穿搭 · 场景 · 真实性）</h3>
                  {a.imageInsights.map((ins, i) => {
                    const img = attachedImages.find((x) => x.id === ins.imageId);
                    return (
                      <div key={ins.imageId} className="image-insight">
                        {img && (
                          <img
                            className="ii-thumb"
                            src={img.dataUrl}
                            alt={img.name || `图${i + 1}`}
                          />
                        )}
                        <div className="ii-body">
                          <div className="ii-tags">
                            {(ins.tags ?? []).map((t) => (
                              <span key={t} className="ii-tag">
                                {t}
                              </span>
                            ))}
                            {ins.authenticity && (
                              <span className="ii-tag ii-auth">{ins.authenticity}</span>
                            )}
                          </div>
                          {ins.scene && <p className="ii-scene">场景：{ins.scene}</p>}
                          {ins.note && <p className="ii-note">{ins.note}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : detail === "action" ? (
            <>
              <h3>{ov ? ACTIONS[ov.action]?.label : "等待聊天"}</h3>
              <p>{ov ? ACTIONS[ov.action]?.detail : "导入后生成建议。"}</p>
              {ov && (
                <p className="hit-note">
                  判断依据：恋爱之神云端库检索 + 她的资料卡
                  {matched ? `（${matched.name}）` : "（未匹配，可点右上角存档建档）"} +
                  上下文聊天（含每条时间戳与当前时间差）+ 好感度六维。
                </p>
              )}
              {ov?.actionEvidenceId && (
                <blockquote>
                  {messages.find((m) => m.id === ov.actionEvidenceId)?.text}
                </blockquote>
              )}
              {ov?.nextReply && (
                <>
                  <h3 className="next-reply-heading">下一句这样说</h3>
                  <blockquote className="next-reply">{ov.nextReply}</blockquote>
                  {ov.nextReplyNote && <p>{ov.nextReplyNote}</p>}
                </>
              )}
              {!!ov?.rounds?.length && (
                <>
                  <h3 className="next-reply-heading">下面几轮这样推</h3>
                  <div className="round-plan">
                    {ov.rounds.map((r) => (
                      <div key={r.round} className="round-card">
                        <div className="round-head">
                          <span className="round-no">第 {r.round} 轮</span>
                          {r.goal && <span className="round-goal">{r.goal}</span>}
                        </div>
                        {r.reply && (
                          <blockquote className="next-reply round-reply">
                            {r.reply}
                          </blockquote>
                        )}
                        {(r.watch || r.ifGood || r.ifCold || r.ifShift) && (
                          <div className="round-branches">
                            {r.watch && <p className="rb-watch">观察：{r.watch}</p>}
                            {r.ifGood && <p className="rb-good">她接 → {r.ifGood}</p>}
                            {r.ifCold && <p className="rb-cold">她冷 → {r.ifCold}</p>}
                            {r.ifShift && (
                              <p className="rb-shift">转话题 → {r.ifShift}</p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {ov?.fiveStep && (
                <>
                  <h3 className="next-reply-heading">五步分析链路</h3>
                  <div className="five-step">
                    {ov.fiveStep.emotion && (
                      <div className="fs-item">
                        <b>情绪落地</b>
                        <p>{ov.fiveStep.emotion}</p>
                      </div>
                    )}
                    {ov.fiveStep.facts && (
                      <div className="fs-item">
                        <b>事实拆分</b>
                        <p>{ov.fiveStep.facts}</p>
                      </div>
                    )}
                    {ov.fiveStep.interest && (
                      <div className="fs-item">
                        <b>利益判断</b>
                        <p>{ov.fiveStep.interest}</p>
                      </div>
                    )}
                    {ov.fiveStep.advice && (
                      <div className="fs-item">
                        <b>明确建议</b>
                        <p>{ov.fiveStep.advice}</p>
                      </div>
                    )}
                    {ov.fiveStep.action && (
                      <div className="fs-item">
                        <b>行动收束</b>
                        <p>{ov.fiveStep.action}</p>
                      </div>
                    )}
                  </div>
                </>
              )}
              {ov && (
                <button
                  className="insight-cta"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    setChatAutoQ(
                      "针对当前「下一步」判断，给我完整的推进思路：为什么要这么做、具体发什么（直接给可复制的话术）、她可能怎么回、每种的接法",
                    );
                    setChatPanel(true);
                  }}
                >
                  <MessagesSquare size={14} /> 要完整推进思路？问大浪指导
                </button>
              )}
              {!!ov?.risks?.length && (
                <>
                  <h3 className="next-reply-heading">风险提示</h3>
                  {ov.risks!.map((r, i) => (
                    <p key={i} className="risk-item">
                      {r}
                    </p>
                  ))}
                </>
              )}
              {!!a.hits?.length && (
                <>
                  <h3 className="next-reply-heading">
                    大浪云端库命中（本次判断依据）
                  </h3>
                  <div className="hit-list">
                    {a.hits
                      .slice()
                      .sort((x, y) => y.score - x.score)
                      .map((h) => (
                        <span key={h.id} className="hit-chip">
                          {h.id} · {Math.round(h.score * 100)}%
                        </span>
                      ))}
                  </div>
                  <p className="hit-note">
                    情绪/意图标签与好感度六维均在以上云端命中（规则/案例/话术/主策略）约束下输出。
                  </p>
                </>
              )}
            </>
          ) : detail === "performance" ? (
            <>
              <div className="detail-score">
                {quality ?? "—"}
                <span>/100</span>
              </div>
              <p>
                已完成分析的我方回复平均分。大浪
                根据发出时的前文评价表达质量，再按固定分数区间显示评级。
              </p>
              <div className="reply-guide">
                {REPLY_RATINGS.map((v) => (
                  <p key={v.label}>
                    <strong>
                      {v.label} · {v.range} 分
                    </strong>
                    ：{v.description}
                  </p>
                ))}
              </div>
            </>
          ) : (
            <>
              <blockquote>{chosen?.text}</blockquote>
              {chosen?.sender === "other" ? (
                <>
                  <h3>情绪</h3>
                  <div className="emotion-distribution">
                    {Object.entries(result?.emotions || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, p]) => (
                        <div key={key}>
                          <span>
                            {EMOTIONS[key as keyof typeof EMOTIONS]?.label ||
                              key}
                          </span>
                          <div className="probability-track">
                            <i style={{ width: `${p * 100}%` }} />
                          </div>
                          <b>
                            {p > 0 && p < 0.005
                              ? "<1%"
                              : `${Math.round(p * 100)}%`}
                          </b>
                        </div>
                      ))}
                  </div>
                  <h3 className="intent-detail-heading">意图</h3>
                  <div className="intent-distribution">
                    {Object.entries(result?.intents || {})
                      .filter(([key, p]) => key in INTENTS && p > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, p]) => (
                        <div key={key} className="intent-detail-item">
                          <div>
                            <strong>
                              {INTENTS[key as keyof typeof INTENTS].label}
                            </strong>
                            <b>
                              {p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`}
                            </b>
                          </div>
                          <p>{INTENTS[key as keyof typeof INTENTS].criteria}</p>
                        </div>
                      ))}
                    {!result?.intents && <p>意图尚未分析。</p>}
                  </div>
                  <p>
                    两行分别展示主要情绪与主要沟通意图的候选解读，不代表测量真实内心。每行最多显示前三项，保留原始概率，不重新凑成
                    100%。
                  </p>
                </>
              ) : (
                <>
                  <h3 className="reply-verdict">
                    回复评级：
                    {replyRating(result?.score.value)?.label ?? "待判断"}
                  </h3>
                  <p>
                    {replyRating(result?.score.value)?.description ??
                      "当前语境不足以判断表达质量"}
                  </p>
                  <p>
                    回复评分 {result?.score.value ?? "—"} / 100 ·{" "}
                    {result && statusLabel(result.score)}
                  </p>
                </>
              )}
              <p>结合当前已导入的上下文判断，不代表对方真实想法。</p>
            </>
          )}
        </Modal>
      )}
      {overlap && (
        <Modal title="这段和你已录入的有重合" close={() => setOverlap(null)}>
          <p className="ms-hint">
            检测到这段记录里，有部分内容与你窗口里已有的聊天重合，无法确定是重复复制还是新的相同内容。请选择：
          </p>
          <button
            className="primary"
            onClick={() => {
              add(overlap, "skip");
              setOverlap(null);
            }}
          >
            跳过重合部分（推荐，只录入新增的）
          </button>
          <button
            className="secondary"
            onClick={() => {
              add(overlap, "append");
              setOverlap(null);
            }}
          >
            全部追加（重合内容也当新消息录入）
          </button>
        </Modal>
      )}
    </main>
  );
}

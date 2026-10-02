import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ImageIcon,
  Loader2,
  MessagesSquare,
  RefreshCw,
} from "lucide-react";
import { apiFetch } from "./api";
import { parseChat } from "../shared/parser";
import type { AnalysisImage, OcrChatResult, OcrLine } from "../shared/types";

/** 统一确认行：文字消息 + 图片消息（图片含内容描述）。mine 是「是否为我」的唯一来源。 */
type Row = {
  uid: number;
  kind: "text" | "image";
  /** 图片行的气泡侧别（left/right）；文字行无用，置空串 */
  side: "left" | "right" | "";
  /** 对方昵称（image 行来自 OCR speakerGuess；text 行来自「名字：」前缀） */
  speaker: string;
  /** 内容：text 行=消息文字；image 行=图片内容描述 */
  text: string;
  time: string;
  mine: boolean;
  /** 2026-09-30 图片占位行：粘贴文字里的「[图片] 文件名.dat」，附图识别后按位替换 */
  pending?: string;
  /** 归属判定通道：text 流的行（含图片占位/替换行）跟「谁是我」名字，ocr 行跟左右侧 */
  via: "text" | "ocr";
};

type Props = {
  images: AnalysisImage[];
  /** 混合粘贴时一并带来的文字聊天记录（可选，例如多选复制里同时有文字和图片） */
  initialText?: string;
  /** 默认对方称呼（绑定资料卡用她的名字） */
  defaultOther: string;
  close: () => void;
  /** 确认：text = 生成的「我：/对方名：」聊天文本，otherName = 最终对方称呼 */
  onConfirm: (text: string, otherName: string) => void;
};

let uidSeq = 0;

/**
 * 聊天记录 → 确认界面（文字 + 图片混合导入）。
 * 文字行直接来自粘贴的「名字：内容」；图片行由视觉模型读内容 + 判谁发的。
 * 谁是自己由用户拍板：文字行用「谁是我」名字按钮，图片行用「右侧/左侧=我」，
 * 每行都可单独翻转归属、可改文字，确认后生成标准文本走现有导入流程。
 */
export default function OcrConfirm({
  images,
  initialText,
  defaultOther,
  close,
  onConfirm,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OcrChatResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [selfSide, setSelfSide] = useState<"right" | "left">("right");
  const [selfName, setSelfName] = useState("");
  const [otherName, setOtherName] = useState(defaultOther || "她");
  const [submitting, setSubmitting] = useState(false);
  const runningRef = useRef(false);

  // 文字行的「谁是我」候选项（去重后的说话人昵称，含图片占位行的说话人）
  const textSpeakers = Array.from(
    new Set(rows.filter((r) => r.via === "text" && r.speaker).map((r) => r.speaker)),
  );
  // 「图片谁发的」侧别选择只对 OCR 平铺出来的图片行有意义（text 流的图片行跟名字走）
  const ocrImageCount = rows.filter((r) => r.kind === "image" && r.via === "ocr").length;

  /** 调一次 chat-ocr（imgs 可以是一张或多张），返回转录行。 */
  async function ocrLines(imgs: AnalysisImage[]): Promise<OcrChatResult> {
    const r = await apiFetch("/api/vision/chat-ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: imgs.map(({ id, name, dataUrl }) => ({ id, name, dataUrl })),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "截图识别失败");
    const res = d as OcrChatResult;
    setResult(res);
    // 预填对方称呼：优先资料卡名字，其次 OCR 读到的对方昵称
    const guess = res.lines.find((l) => l.speakerGuess);
    if (guess?.speakerGuess && (!defaultOther || defaultOther === "她"))
      setOtherName(guess.speakerGuess);
    return res;
  }

  async function run() {
    if (runningRef.current) return;
    runningRef.current = true;
    setLoading(true);
    setError("");
    try {
      const merged: Row[] = [];

      // ① 文字行：来自混合粘贴的聊天文字；「[图片] 文件名」占位行标记为待识别图片行
      if (initialText && initialText.trim()) {
        const p = parseChat(initialText);
        for (const m of p.messages) {
          const speaker = m.speaker === "未分配" ? "" : m.speaker;
          const ph = m.text.match(/^\[图片\]\s*(.*)$/);
          if (ph) {
            merged.push({
              uid: ++uidSeq,
              kind: "image",
              side: "",
              speaker,
              text: "",
              time: m.timestamp ?? "",
              mine: speaker === "我",
              pending: ph[1].trim(),
              via: "text",
            });
          } else {
            merged.push({
              uid: ++uidSeq,
              kind: "text",
              side: "",
              speaker,
              text: m.text,
              time: m.timestamp ?? "",
              mine: speaker === "我",
              via: "text",
            });
          }
        }
      }

      // ② 图片行：有占位行 → 附图对号入座逐张识别、按位替换；无占位 → 批量识别追加（原行为）
      const placeholders = merged.filter((r) => r.kind === "image" && r.via === "text");
      const inserts = new Map<number, Row[]>(); // 占位行 uid → 替换它的行
      const stripExt = (s: string) => s.replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
      let tail: OcrLine[] = [];

      if (images.length && placeholders.length) {
        // 对号：文件名精确/包含匹配优先（微信图片_xxx.dat ↔ 同名图片文件），剩余按顺序补位
        const used = new Set<string>();
        const bind = new Map<Row, AnalysisImage>();
        for (const row of placeholders) {
          if (!row.pending) continue;
          const b = stripExt(row.pending);
          const hit = images.find((img) => {
            if (used.has(img.id) || !img.name) return false;
            const a = stripExt(img.name);
            return a === b || (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a)));
          });
          if (hit) {
            bind.set(row, hit);
            used.add(hit.id);
          }
        }
        const restRows = placeholders.filter((r) => !bind.has(r));
        const restImgs = images.filter((img) => !used.has(img.id));
        for (let i = 0; i < Math.min(restRows.length, restImgs.length); i++) {
          bind.set(restRows[i], restImgs[i]);
          used.add(restImgs[i].id);
        }
        // 被绑定的图逐张识别（串行防限频），识别行继承占位行的说话人/归属/时间——
        // 图片本体识别出的 side/speakerGuess 不可靠，以文字流里的名字前缀为准
        for (const [row, img] of bind) {
          const res = await ocrLines([img]);
          inserts.set(
            row.uid,
            res.lines.map((l) => ({
              uid: ++uidSeq,
              kind: l.kind ?? "text",
              side: "",
              speaker: row.speaker,
              text: l.text || l.imageDesc || row.pending || "",
              time: row.time || l.time || "",
              mine: row.mine,
              via: "text" as const,
            })),
          );
        }
        // 没对上号的附图（图多/占位多）：合并一批识别，追加到末尾
        const leftover = images.filter((img) => !used.has(img.id));
        if (leftover.length) tail = (await ocrLines(leftover)).lines;
      } else if (images.length) {
        tail = (await ocrLines(images)).lines;
      }

      // ③ 重建：占位行按位替换（识别行继承说话人），未替换的占位行保留原样等用户手填
      const rebuilt: Row[] = [];
      for (const row of merged) {
        const ins = inserts.get(row.uid);
        if (ins?.length) rebuilt.push(...ins);
        else rebuilt.push(row);
      }
      for (const l of tail) {
        rebuilt.push({
          uid: ++uidSeq,
          kind: l.kind ?? "text",
          side: l.side,
          speaker: l.speakerGuess || "",
          text: l.text,
          time: l.time || "",
          mine: l.side === "right", // 微信惯例：右侧=机主
          via: "ocr",
        });
      }
      setRows(rebuilt);

      // 文字行自动判断「我」：有叫「我」的直接选中；只有一个非「我」说话人则默认全是对方
      const speakers = Array.from(
        new Set(rebuilt.filter((r) => r.via === "text" && r.speaker).map((r) => r.speaker)),
      );
      if (speakers.includes("我")) setSelfName("我");
      else if (speakers.length === 1) setSelfName("__self_absent__");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      runningRef.current = false;
    }
  }

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 「谁是我」选定后：重排 text 流所有行（含图片占位/替换行——它们的说话人来自名字前缀）的归属。 */
  function pickSelfName(name: string) {
    setSelfName(name);
    setRows((prev) =>
      prev.map((r) =>
        r.via === "text" ? { ...r, mine: name === "__self_absent__" ? false : r.speaker === name } : r,
      ),
    );
  }

  /** 图片行「右侧/左侧=我」：重排图片行归属。 */
  function pickSelfSide(side: "right" | "left") {
    setSelfSide(side);
    setRows((prev) =>
      prev.map((r) =>
        r.kind === "image" ? { ...r, mine: r.side === side } : r,
      ),
    );
  }

  function flipRow(uid: number) {
    setRows((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, mine: !r.mine } : r)),
    );
  }

  function setRowText(uid: number, text: string) {
    setRows((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, text } : r)),
    );
  }

  function submit() {
    if (!rows.length || submitting) return;
    setSubmitting(true);
    const other = otherName.trim() || "她";
    const text = rows
      .map((l) => {
        const name = l.mine ? "我" : l.speaker || other;
        const content =
          l.kind === "image"
            ? l.text.trim()
              ? `[图片] ${l.text.trim()}`
              : l.pending
                ? `[图片] ${l.pending}` // 没识别到的占位行：保留原文件名，不丢信息
                : "[图片]"
            : l.text.trim();
        return l.time ? `[${l.time}] ${name}：${content}` : `${name}：${content}`;
      })
      .join("\n");
    onConfirm(text, other);
  }

  const otherCount = rows.filter((r) => !r.mine).length;
  const selfCount = rows.length - otherCount;
  const imageCount = rows.filter((r) => r.kind === "image").length;

  return (
    <div className="ocr-confirm">
      {loading && (
        <div className="ocr-loading">
          <Loader2 size={20} className="spin" />
          <p>AI 正在逐条读取{images.length ? ` ${images.length} 张图片` : ""}…</p>
          <p className="ocr-loading-sub">长截图识别会慢一些（约 10-40 秒），别关窗口</p>
        </div>
      )}
      {!loading && error && (
        <div className="ocr-error">
          <p className="error">{error}</p>
          <button className="secondary" onClick={() => void run()}>
            <RefreshCw size={14} /> 重新识别
          </button>
        </div>
      )}
      {!loading && !error && (
        <>
          {result?.layoutNote && <p className="ocr-layout">AI 布局判读：{result.layoutNote}</p>}

          {textSpeakers.length > 0 && (
            <div className="ocr-meta-row ocr-name-pick">
              <span>文字里谁是你：</span>
              {textSpeakers.map((n) => (
                <button
                  key={n}
                  className={selfName === n ? "selected" : ""}
                  onClick={() => pickSelfName(n)}
                >
                  {n} ＝ 我
                </button>
              ))}
              <button
                className={selfName === "__self_absent__" ? "selected" : ""}
                onClick={() => pickSelfName("__self_absent__")}
              >
                全是对方说的
              </button>
            </div>
          )}

          {ocrImageCount > 0 && (
            <div className="ocr-meta-row">
              <div className="ocr-side-pick">
                <span>图片谁发的：</span>
                <button
                  className={selfSide === "right" ? "selected" : ""}
                  onClick={() => pickSelfSide("right")}
                >
                  右侧气泡 = 我
                </button>
                <button
                  className={selfSide === "left" ? "selected" : ""}
                  onClick={() => pickSelfSide("left")}
                >
                  左侧气泡 = 我
                </button>
                <button
                  className="ocr-swap"
                  title="一键把图片左右归属翻转"
                  onClick={() => pickSelfSide(selfSide === "right" ? "left" : "right")}
                >
                  <ArrowLeftRight size={13} /> 翻转
                </button>
              </div>
            </div>
          )}

          <div className="ocr-meta-row">
            <label className="field ocr-other-name">
              对方称呼
              <input value={otherName} onChange={(e) => setOtherName(e.target.value)} />
            </label>
          </div>

          <p className="ocr-count">
            共 {rows.length} 条（我方 {selfCount} · 对方 {otherCount} · 图片 {imageCount}
            ）。<b>逐条检查文字、图片内容和谁发的</b>；读错/归属错的地方直接改；改完点下方按钮转为聊天记录。
          </p>

          <div className="ocr-lines">
            {rows.length === 0 && (
              <p className="error">没识别出对话内容：确认贴的是聊天截图或聊天里发的图片。</p>
            )}
            {rows.map((l) => {
              const mine = l.mine;
              const displayName = mine ? "我" : l.speaker || otherName || "她";
              return (
                <div key={l.uid} className={`ocr-line ${mine ? "mine" : ""} ${l.kind === "image" ? "is-image" : ""}`}>
                  {l.kind === "image" && (
                    <span
                      className="ocr-img-badge"
                      title={l.pending && !l.text ? "图片消息（占位：还没识别到内容）" : "图片消息"}
                    >
                      <ImageIcon size={12} /> 图片
                    </span>
                  )}
                  <span className="ocr-speaker">{displayName}</span>
                  {l.time && <code className="ocr-time">{l.time}</code>}
                  <input
                    value={l.text || l.pending || ""}
                    placeholder={l.kind === "image" ? "图片内容描述（AI 已填，可改）" : "识别文字"}
                    onChange={(e) => setRowText(l.uid, e.target.value)}
                    aria-label="修改识别内容"
                  />
                  <button
                    className="ocr-line-flip"
                    title={mine ? "改成对方发的" : "改成我发的"}
                    onClick={() => flipRow(l.uid)}
                  >
                    <ArrowLeftRight size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="pi-actions">
            <button
              className="primary"
              disabled={!rows.length || submitting}
              onClick={submit}
            >
              {submitting ? (
                <>
                  <Loader2 size={15} className="spin" /> 转换中…
                </>
              ) : (
                <>
                  <MessagesSquare size={15} /> 转为聊天记录并开始分析
                </>
              )}
            </button>
            <button className="secondary" onClick={close} disabled={submitting}>
              取消
            </button>
          </div>
        </>
      )}
    </div>
  );
}

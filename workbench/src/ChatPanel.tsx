import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Send, X } from "lucide-react";
import { apiFetch } from "./api";

export type ChatMsg = { role: "user" | "assistant"; content: string };

const QUICK_PROMPTS = [
  "结合她的资料卡和当前聊天，给我做一次恋爱推进分析：到哪一步了、卡点在哪、下一步怎么推进，直接给可发的话术",
  "她最新这条消息是什么意思？",
  "下一句怎么发？直接给话术",
  "怎么把她约出来？",
  "现在有什么风险要注意？",
];

/**
 * 轻量 Markdown 渲染（零依赖，2026-10-01）：
 * 大浪回复是结构化 markdown（**小标题**、- 列表、编号），原样 innerText 会把
 * `**当前阶段**` 星号直接漏给用户、挤成一坨。这里只解析安全子集：
 * **加粗** / `行内代码` / # ## ### 标题 / - • 列表 / 空行分段。不引入外部依赖。
 */
function inline(s: string): ReactNode[] {
  return s
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
        return <strong key={i}>{p.slice(2, -2)}</strong>;
      if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
        return <code key={i}>{p.slice(1, -1)}</code>;
      return p;
    });
}

function renderRich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (!list.length) return;
    out.push(
      <ul key={key}>
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    flush(`ul${i}`);
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      out.push(
        <p key={i} className="cp-h">
          {inline(h[1])}
        </p>,
      );
      return;
    }
    if (!line.trim()) {
      out.push(<div key={i} className="cp-gap" />);
      return;
    }
    out.push(
      <p key={i} className="cp-p">
        {inline(line)}
      </p>,
    );
  });
  flush("ul-tail");
  return out;
}

export default function ChatPanel({
  close,
  profileId,
  profileName,
  chatLog,
  relation,
  analysisSummary,
  msgs,
  setMsgs,
  autoQuestion,
}: {
  close: () => void;
  profileId?: string;
  profileName?: string;
  chatLog: string;
  relation: string;
  analysisSummary?: string;
  /** 对话记录由父组件持有：关闭面板不丢，切女生窗口各自隔离 */
  msgs: ChatMsg[];
  setMsgs: (next: ChatMsg[]) => void;
  autoQuestion?: string;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [vectorActive, setVectorActive] = useState<boolean | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sentAuto = useRef(false);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: ChatMsg[] = [...msgs, { role: "user", content }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    setStreaming(false);
    setError("");
    try {
      const resp = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.slice(-16),
          profileId,
          chatLog,
          relation,
          analysisSummary,
          stream: true,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(body?.error || `对话失败（${resp.status}）`);
      }
      const ctype = resp.headers.get("content-type") || "";
      if (!ctype.includes("text/event-stream") || !resp.body) {
        // 兜底：后端老逻辑仍返回 json
        const body = await resp.json();
        setVectorActive(body.vectorActive === false ? false : body.vectorActive === true ? true : null);
        setMsgs([...next, { role: "assistant", content: body.reply ?? "" }]);
        return;
      }
      // 流式：逐帧 JSON 解析 delta，边收边显示
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      let streamError = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let obj: {
            delta?: string;
            done?: boolean;
            error?: string;
            vectorActive?: boolean;
          };
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (typeof obj.delta === "string") {
            acc += obj.delta;
            setStreaming(true);
            setMsgs([...next, { role: "assistant", content: acc }]);
          } else if (obj.error) {
            streamError = obj.error;
          } else if (obj.done) {
            setVectorActive(obj.vectorActive === false ? false : obj.vectorActive === true ? true : null);
          }
        }
      }
      if (streamError) {
        setError(streamError);
        setMsgs(acc ? [...next, { role: "assistant", content: acc }] : next);
        return;
      }
      setMsgs([...next, { role: "assistant", content: acc }]);
    } catch (e) {
      setError((e as Error).message);
      // 失败时把这条用户消息保留，方便重发
      setMsgs(next);
    } finally {
      setBusy(false);
      setStreaming(false);
    }
  }

  useEffect(() => {
    if (!sentAuto.current && autoQuestion) {
      sentAuto.current = true;
      void send(autoQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: "smooth",
    });
  }, [msgs, busy]);

  return (
    <div className="cp">
      <p className="ms-hint">
        大浪指导：恋爱之神云端库 + 她的资料卡
        {profileName ? `（${profileName}）` : ""}
        + 已有聊天分析结论，综合对话。聊天记录不用重复分析，直接问推进。对话记录按窗口保存，关了再开还在。
      </p>
      {vectorActive === false && (
        <p className="cp-vector-lock">
          未订阅向量库——本轮只有模型判断，没接入大浪实战库命中。点右上角「向量库订阅」（6.6元/月）解锁案例/策略深度命中。
        </p>
      )}
      <div className="cp-quick">
        {QUICK_PROMPTS.map((q, i) => (
          <button
            key={i}
            className="cp-chip"
            disabled={busy}
            onClick={() => void send(q)}
          >
            {i === 0 ? "✨ " : ""}
            {q.length > 14 ? `${q.slice(0, 14)}…` : q}
          </button>
        ))}
      </div>
      <div className="cp-scroll" ref={scroller}>
        {!msgs.length && !busy && (
          <p className="cp-empty">
            点上面的快捷提问，或直接输入。她会结合云端案例库、资料卡和分析结论给你可执行的动作。
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`cp-msg ${m.role}`}>
            <div className={`cp-bubble${m.role === "assistant" ? " cp-rich" : ""}`}>
              {m.role === "assistant" ? renderRich(m.content) : m.content}
            </div>
          </div>
        ))}
        {busy && !streaming && (
          <div className="cp-msg assistant">
            <div className="cp-bubble cp-thinking">
              <Loader2 size={14} className="spin" /> 大浪在想…
            </div>
          </div>
        )}
      </div>
      {error && <p className="ms-error">{error}</p>}
      <div className="cp-input">
        <textarea
          value={input}
          rows={2}
          placeholder="问她什么意思、下一句怎么发、怎么推进…（Enter 发送）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="cp-actions">
          <button
            className="secondary"
            onClick={() => setMsgs([])}
            disabled={!msgs.length}
          >
            清空记录
          </button>
          <button className="secondary" onClick={close}>
            <X size={14} /> 关闭
          </button>
          <button
            className="primary"
            disabled={busy || !input.trim()}
            onClick={() => void send(input)}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

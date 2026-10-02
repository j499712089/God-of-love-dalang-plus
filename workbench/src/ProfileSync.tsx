import { useEffect, useState } from "react";
import { Loader2, Save, FolderHeart, PlusCircle, RefreshCw } from "lucide-react";
import { apiFetch } from "./api";
import type { Message, Overview } from "../shared/types";

type RosterItem = { id: string; name: string; platform: string };

export default function ProfileSync({
  other,
  messages,
  overview,
  close,
  onBound,
}: {
  other: string;
  messages: Message[];
  overview: Overview | null;
  close: () => void;
  /** 写入成功后把窗口绑定到该资料卡（持久化，不再重复匹配） */
  onBound?: (id: string, name: string) => void;
}) {
  const [roster, setRoster] = useState<RosterItem[]>([]);
  const [mode, setMode] = useState<"new" | "update">("new");
  const [id, setId] = useState("");
  const [name, setName] = useState(other);
  const [platform, setPlatform] = useState("微信");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/api/profile/list")
      .then((r) => r.json())
      .then((d) => {
        const list = d.roster as RosterItem[];
        setRoster(list);
        const match = list.find((r) => r.name === other);
        if (match) {
          setMode("update");
          setTarget(match.id);
        }
        if (list.length) setMode("update");
      })
      .catch(() => setError("档案库读取失败"));
  }, [other]);

  async function sync(idTarget: string) {
    const recent = messages.slice(-30);
    // 2026-09-30 修复：原来每条 POST 不检查 resp.ok——失败被静默吞掉，
    // 最后仍提示「已同步 N 条」，用户以为聊天进了资料卡，打开一看 timeline 是空的。
    // 现在逐条校验，失败立刻抛错并带进度，绝不谎报成功。
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const who = m.sender === "self" ? "我" : "她";
      const t = m.timestamp || "第N轮";
      const resp = await apiFetch(`/api/profile/${idTarget}/timeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t, who, text: m.text, gap: "未知" }),
      });
      if (!resp.ok) {
        const d = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          `第 ${i + 1}/${recent.length} 条写入资料卡失败：${d?.error || `HTTP ${resp.status}`}。已写入 ${i} 条，未写入的请重试本操作。`,
        );
      }
    }
    if (overview?.note) {
      const resp = await apiFetch(`/api/profile/${idTarget}/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: overview.note }),
      });
      if (!resp.ok)
        throw new Error(
          `聊天已写入资料卡，但分析结论（summary）写入失败：HTTP ${resp.status}。可在档案库手动补。`,
        );
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      let idTarget = target;
      if (mode === "new") {
        if (!id.trim() || !name.trim()) throw new Error("请填写 id 和姓名");
        const resp = await apiFetch("/api/profile/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: id.trim(), name: name.trim(), platform }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "建档失败");
        idTarget = data.id ?? id.trim();
      }
      if (!idTarget) throw new Error("请选择或新建档案");
      await sync(idTarget);
      // 绑定本窗口到该资料卡（含新建的），之后分析自动带上档案
      const boundName =
        mode === "new"
          ? name.trim()
          : (roster.find((r) => r.id === idTarget)?.name ?? other);
      onBound?.(idTarget, boundName);
      setDone(
        `已绑定本窗口到「${boundName}」并同步 ${messages.length} 条聊天记录。可在档案库查看。`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ps">
      <p className="ps-hint">
        把<b>当前窗口的聊天记录</b>写入女生档案库（时间线 + 分析结论）。已按「{other}」匹配档案；也可新建或改选。朋友圈/新照片等资料请用下方「更新资料」导入，别混在这里。
      </p>
      <div className="ps-mode">
        <button
          className={mode === "new" ? "selected" : ""}
          onClick={() => setMode("new")}
        >
          <PlusCircle size={15} /> 新建档案
        </button>
        <button
          className={mode === "update" ? "selected" : ""}
          onClick={() => setMode("update")}
          disabled={!roster.length}
        >
          <RefreshCw size={15} /> 更新已有
        </button>
      </div>

      {mode === "new" ? (
        <div className="ps-fields">
          <label className="field">
            id（拼音_平台，如 xiaomei_wechat）
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="xiaomei_wechat" />
          </label>
          <label className="field">
            姓名 / 昵称
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            平台
            <input value={platform} onChange={(e) => setPlatform(e.target.value)} />
          </label>
        </div>
      ) : (
        <label className="field">
          选择档案
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">— 选择 —</option>
            {roster.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}（{r.id}）
              </option>
            ))}
          </select>
        </label>
      )}

      {error && <p className="error">{error}</p>}
      {done && <p className="ps-done">{done}</p>}

      <div className="ps-actions">
        <button className="secondary" onClick={close}>
          关闭
        </button>
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
          {busy ? "同步中…" : "写入档案"}
        </button>
      </div>
      <p className="ps-note">
        <FolderHeart size={13} /> 会追加最近 30 条为时间线，并把分析结论写入 summary。
      </p>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Search, Upload } from "lucide-react";
import { apiFetch } from "./api";
import LocalImport from "./LocalImport";

type RosterItem = {
  id: string;
  name: string;
  platform: string;
  verdict: string;
  interest: number;
  truth_level?: string;
  updated?: number;
  rank?: number;
};
type Roster = { updated: number; roster: RosterItem[] };

type TruthCheck = { dim: string; result: string; level: string };
type Inference = {
  title: string;
  confidence: string;
  evidence: string;
  readings: string[];
  means?: string;
};
type PlanRound = { n?: number; goal?: string; line?: string };
type StopRule = { signal?: string; action?: string };
type Plan = {
  stage?: string;
  opener?: string;
  opener_why?: string[];
  rounds?: PlanRound[];
  invite_rules?: string[];
  stop_rules?: StopRule[];
  funnel_note?: string;
};
type Photo = { n?: number; content?: string; decode?: string };
type TimelineItem = { t?: string; who?: string; text?: string; gap?: string };

type Profile = Record<string, unknown> & {
  id: string;
  name?: string;
  platform?: string;
  verdict?: string;
  interest?: number;
  truth_level?: string;
  facts?: Record<string, unknown>;
  interest_breakdown?: Record<string, number>;
  truth_check?: TruthCheck[];
  truth_note?: string;
  inferences?: Inference[];
  position?: { chance?: string[]; risk?: string[] };
  plan?: Plan;
  timeline?: TimelineItem[];
  photos?: Photo[];
  summary?: string;
  gaps?: string[];
};

// 六项满分（与 profile_cli.py SCORE_CAPS 一致），条宽按各自满分算，否则权重条全错
const BREAKDOWN_CAP: Record<string, number> = {
  intent: 25,
  speed: 20,
  respond: 20,
  match: 15,
  truth: 10,
  risk: 10,
};
const BREAKDOWN_LABEL: Record<string, string> = {
  intent: "婚恋意愿",
  speed: "推进速度",
  respond: "响应质量",
  match: "匹配契合",
  truth: "真实度",
  risk: "风险余量",
};
const BREAKDOWN_ORDER = ["intent", "speed", "respond", "match", "truth", "risk"];

const VERDICT_COLOR: Record<string, string> = {
  推进中: "#e0b15c",
  观察中: "#7fa3c7",
  已止损: "#9a8f8f",
};

function intColor(v: number) {
  return v >= 70 ? "#4ade80" : v >= 40 ? "#fbbf24" : "#f87171";
}

function fmtTime(ms?: number) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export default function ProfileBoard({
  focusId,
  bindMode = false,
  boundId = null,
  onSelectCard,
  onCreateCard,
}: {
  focusId?: string | null;
  /** 绑定模式：点击资料卡不进详情，直接绑定到当前聊天窗口 */
  bindMode?: boolean;
  /** 当前聊天窗口已绑定的资料卡 id（绑定模式下显示「已绑定」标记） */
  boundId?: string | null;
  onSelectCard?: (id: string, name: string) => void;
  onCreateCard?: (name: string) => void;
}) {
  const [roster, setRoster] = useState<Roster>({ updated: 0, roster: [] });
  const [detail, setDetail] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "推进中" | "观察中" | "已止损">("all");
  const [showImport, setShowImport] = useState(false);

  function load() {
    apiFetch("/api/profile/list")
      .then((r) => r.json())
      .then((d) => {
        // 防御：后端 401/500 时返回的不是 {updated, roster}，直接 setRoster 会
        // 让 roster.roster 变成 undefined，导致 [...undefined] 崩溃 → 整页空白。
        if (d && Array.isArray(d.roster)) {
          setRoster({ updated: typeof d.updated === "number" ? d.updated : 0, roster: d.roster });
        } else {
          setError(d?.error || "档案库数据异常");
        }
      })
      .catch(() => setError("档案库读取失败"));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部指定资料卡（聊天页点「她的资料卡」直达）：自动打开对应详情
  useEffect(() => {
    if (focusId) open(focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  function open(id: string) {
    setLoading(true);
    setError("");
    apiFetch(`/api/profile/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then((d) => setDetail(d))
      .catch(() => setError("档案详情读取失败"))
      .finally(() => setLoading(false));
  }

  // 防御：任何异常数据都归一化成数组，杜绝 [...undefined] 崩溃 → 空白页
  const items = Array.isArray(roster.roster) ? roster.roster : [];

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => b.interest - a.interest || (b.updated ?? 0) - (a.updated ?? 0),
      ),
    [roster],
  );
  const total = items.length;
  const pushing = items.filter((r) => r.verdict === "推进中").length;
  const watching = items.filter((r) => r.verdict === "观察中").length;
  const stopped = items.filter((r) => r.verdict === "已止损").length;

  const filtered = sorted.filter((r) => {
    if (filter !== "all" && r.verdict !== filter) return false;
    if (!q.trim()) return true;
    const hay = `${r.name} ${r.platform} ${r.verdict} ${r.truth_level ?? ""}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  if (detail) return <ProfileDetail p={detail} back={() => setDetail(null)} />;

  return (
    <section className="profile-board">
      <header className="pb-head">
        <div>
          <h2>女生档案库</h2>
          <p>
            共 {total} 份 · 推进中 {pushing} · 观察中 {watching} · 已止损 {stopped}
          </p>
        </div>
        <button
          className="pb-import-btn"
          onClick={() => setShowImport(true)}
          title="旧版「本地页面 + 数据库」用户一键迁移档案到云端，免二次录入"
        >
          <Upload size={15} /> 导入本地资料库
        </button>
      </header>

      {bindMode && (
        <div className="pb-bind-hint">
          <strong>绑定当前窗口：</strong>
          {boundId ? (
            <>
              本窗口已绑定「
              {items.find((r) => r.id === boundId)?.name ?? boundId}
              」✓ 可点其他卡换绑，或返回聊天窗直接粘贴。
            </>
          ) : (
            <>
              点一张资料卡上的「绑定」按钮 → 自动绑定并把她档案里的历史聊天拉进窗口（自动去重对齐），之后可直接继续粘贴新聊天。
            </>
          )}
        </div>
      )}
      {bindMode && (
        <div className="pb-create">
          <input
            value={newName}
            placeholder="库里有她？没有就输入名字新建"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim() && onCreateCard) {
                onCreateCard(newName.trim());
                setNewName("");
              }
            }}
          />
          <button
            className="primary"
            disabled={!newName.trim() || !onCreateCard}
            onClick={() => {
              onCreateCard?.(newName.trim());
              setNewName("");
            }}
          >
            新建并绑定
          </button>
        </div>
      )}
      {error && <p className="pb-error">{error}</p>}

      {/* 统计卡 */}
      <div className="pb-stats">
        <div className="pb-stat"><b>{total}</b><span>总档案</span></div>
        <div className="pb-stat p"><b>{pushing}</b><span>推进中</span></div>
        <div className="pb-stat w"><b>{watching}</b><span>观察中</span></div>
        <div className="pb-stat s"><b>{stopped}</b><span>已止损</span></div>
      </div>

      {/* 兴趣度排行榜 */}
      {sorted.length > 0 && (
        <div className="pb-rank">
          <div className="pb-rank-hd">
            <h3>▲ 兴趣度排行</h3>
            <small>分数 = 六项加权，命中幻觉/已止损锁 30 分</small>
          </div>
          {sorted.map((r, i) => (
            <button
              key={r.id}
              className="pb-rank-row"
              onClick={() => (bindMode && onSelectCard ? onSelectCard(r.id, r.name) : open(r.id))}
            >
              <span className={`pb-rk-no rk-${i + 1}`}>{i + 1}</span>
              <span className="pb-rk-name">{r.name}</span>
              <span className="pb-rk-plat">{r.platform}</span>
              <span className="pb-rk-bar">
                <i style={{ width: `${r.interest}%`, background: intColor(r.interest) }} />
              </span>
              <b className="pb-rk-val" style={{ color: intColor(r.interest) }}>
                {r.interest}
              </b>
              <span className="pb-rk-vd" style={{ color: VERDICT_COLOR[r.verdict] ?? "#888" }}>
                {r.verdict}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 搜索 + 筛选 */}
      <div className="pb-toolbar">
        <div className="pb-search">
          <Search size={14} />
          <input
            value={q}
            placeholder="搜索姓名 / 平台 / 结论…"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="pb-chips">
          {(["all", "推进中", "观察中", "已止损"] as const).map((f) => (
            <button
              key={f}
              className={`pb-chip ${filter === f ? "on" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "全部" : f}
            </button>
          ))}
        </div>
      </div>

      <div className="pb-grid">
        {filtered.map((r) => {
          const bound = bindMode && boundId === r.id;
          const cardBody = (
            <>
              <div className="pb-card-top">
                <span className="pb-avatar">{r.name?.slice(0, 1) || "?"}</span>
                <div className="pb-card-title">
                  <strong>{r.name}</strong>
                  <span>{r.platform}</span>
                </div>
                <span className="pb-interest" style={{ color: intColor(r.interest) }}>
                  {r.interest}
                </span>
              </div>
              <div className="pb-card-meta">
                <span className={`pb-verdict v-${r.verdict}`}>{r.verdict}</span>
                <span>真实度 {r.truth_level || "未评"}</span>
                {r.updated ? <span>{fmtTime(r.updated)}</span> : null}
              </div>
              {bindMode && (
                <div className="pb-card-bind">
                  {bound ? (
                    <span className="pb-bound-mark">✓ 已绑定本窗口</span>
                  ) : (
                    <button
                      className="pb-bind-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectCard?.(r.id, r.name);
                      }}
                    >
                      绑定到本窗口
                    </button>
                  )}
                </div>
              )}
            </>
          );
          return bindMode ? (
            <div
              key={r.id}
              role="button"
              tabIndex={0}
              className={`pb-card${bound ? " bound" : ""}`}
              title={`点选绑定「${r.name}」到当前聊天窗口`}
              onClick={() => onSelectCard?.(r.id, r.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelectCard?.(r.id, r.name);
              }}
              style={{ borderTopColor: VERDICT_COLOR[r.verdict] ?? "#666" }}
            >
              {cardBody}
            </div>
          ) : (
            <button
              key={r.id}
              className="pb-card"
              onClick={() => open(r.id)}
              style={{ borderTopColor: VERDICT_COLOR[r.verdict] ?? "#666" }}
            >
              {cardBody}
            </button>
          );
        })}
        {!items.length && !error && (
          <p className="pb-empty">档案库为空，导入聊天后可建档。</p>
        )}
        {items.length > 0 && filtered.length === 0 && (
          <p className="pb-empty">没有匹配的档案。</p>
        )}
      </div>
      {loading && <p className="pb-loading">加载详情…</p>}
      {showImport && <LocalImport close={() => setShowImport(false)} onDone={load} />}
    </section>
  );
}

function ProfileDetail({ p, back }: { p: Profile; back: () => void }) {
  const iv = p.interest ?? 0;
  const rank = p.rank as number | undefined;

  const bdRows = BREAKDOWN_ORDER.map((k) => {
    const cap = BREAKDOWN_CAP[k] ?? 25;
    const v = Math.min(Number(p.interest_breakdown?.[k]) || 0, cap);
    const pct = cap ? (v / cap) * 100 : 0;
    return (
      <div key={k} className="pb-bd-row">
        <span className="pb-bd-l">{BREAKDOWN_LABEL[k]}</span>
        <div className="pb-bd-bar">
          <i
            style={{
              width: `${pct}%`,
              background: pct >= 60 ? "#4ade80" : pct >= 30 ? "#fbbf24" : "#f87171",
            }}
          />
        </div>
        <b className="pb-bd-v">{v}</b>
        <span className="pb-bd-c">/{cap}</span>
      </div>
    );
  });

  const photos = p.photos?.length ? (
    <table className="pb-tb">
      <thead>
        <tr><th style={{ width: 36 }}>#</th><th style={{ width: "36%" }}>内容</th><th>解码</th></tr>
      </thead>
      <tbody>
        {p.photos.map((x, i) => (
          <tr key={i}>
            <td className="dim">{x.n || i + 1}</td>
            <td>{x.content || ""}</td>
            <td>{x.decode || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : (
    <p className="pb-none">暂无照片解码</p>
  );

  const tc = p.truth_check?.length ? (
    <div className="pb-truth">
      {p.truth_check.map((t, i) => (
        <div key={i} className="pb-truth-item">
          <strong>{t.dim}</strong>
          <span className={`pb-level lv-${t.level}`}>{t.level}</span>
          <p>{t.result}</p>
        </div>
      ))}
      {p.truth_note ? <p className="pb-truth-note"><b>评级依据：</b>{p.truth_note}</p> : null}
    </div>
  ) : (
    <p className="pb-none">暂无核验记录</p>
  );

  const inf = p.inferences?.length ? (
    <div className="pb-infs">
      {p.inferences.map((x, i) => (
        <div key={i} className="pb-inference">
          <div className="pb-inf-head">
            <strong>{x.title}</strong>
            <span className={`pb-conf c-${x.confidence}`}>{x.confidence}置信</span>
          </div>
          <p className="pb-inf-ev"><em>证据链</em>{x.evidence}</p>
          {x.readings?.length ? (
            <p className="pb-inf-rd"><em>两种解释</em>{x.readings.map((r) => `「${r}」`).join(" ")}</p>
          ) : null}
          {x.means ? <p className="pb-inf-rd means"><em>对你意味着</em>{x.means}</p> : null}
        </div>
      ))}
    </div>
  ) : (
    <p className="pb-none">暂无推断</p>
  );

  const pos = p.position;
  const posBox = pos ? (
    <div className="pb-pos">
      {pos.chance?.length ? (
        <div className="pb-pos-col ok">
          <h4>机会</h4>
          {pos.chance.map((c, i) => <p key={i}>+ {c}</p>)}
        </div>
      ) : null}
      {pos.risk?.length ? (
        <div className="pb-pos-col bad">
          <h4>风险</h4>
          {pos.risk.map((c, i) => <p key={i}>- {c}</p>)}
        </div>
      ) : null}
    </div>
  ) : null;

  const plan = p.plan;
  const planBox = plan ? (
    <div className="pb-plan">
      {plan.stage ? (
        <div className="pb-pl-stage"><em>阶段定位</em><span>{plan.stage}</span></div>
      ) : null}
      {plan.opener ? (
        <div className="pb-pl-opener">
          <span className="pb-pl-tag">破冰消息</span>
          <p>{plan.opener}</p>
          {plan.opener_why?.length ? (
            <ul className="pb-pl-why">
              {plan.opener_why.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
      {plan.rounds?.length ? (
        <table className="pb-tb">
          <thead><tr><th style={{ width: 42 }}>轮</th><th style={{ width: "30%" }}>目标</th><th>关键话</th></tr></thead>
          <tbody>
            {plan.rounds.map((r, i) => (
              <tr key={i}><td className="dim">{r.n || i + 1}</td><td>{r.goal}</td><td>{r.line}</td></tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {plan.invite_rules?.length || plan.stop_rules?.length ? (
        <div className="pb-pos">
          {plan.invite_rules?.length ? (
            <div className="pb-pos-col"><h4>邀约纪律</h4>{plan.invite_rules.map((t, i) => <p key={i}>{t}</p>)}</div>
          ) : null}
          {plan.stop_rules?.length ? (
            <div className="pb-pos-col bad">
              <h4>降速 / 止损</h4>
              {plan.stop_rules.map((s, i) => (
                <p key={i}><b>{s.signal}</b> → {s.action}</p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {plan.funnel_note ? <p className="pb-pl-funnel"><b>漏斗纪律：</b>{plan.funnel_note}</p> : null}
    </div>
  ) : null;

  const tl = p.timeline?.length ? (
    <div className="pb-timeline">
      {p.timeline.slice(-20).map((t, i) => (
        <div key={i} className="pb-tl-item">
          <span className={`pb-tl-who ${t.who === "她" ? "her" : ""}`}>{t.who}</span>
          <div>
            <p>{t.text}</p>
            <small>{t.t}{t.gap ? ` · 间隔 ${t.gap}` : ""}</small>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <p className="pb-none">暂无互动记录 — 公域阶段尚未破冰</p>
  );

  const gaps = p.gaps?.length ? (
    <div className="pb-gaps">
      <h4>⚠ 需主人确认的变量（缺失则不下结论）</h4>
      <ol>{p.gaps.map((g, i) => <li key={i}>{g}</li>)}</ol>
    </div>
  ) : null;

  return (
    <section className="profile-detail">
      <header className="pb-head">
        <button className="pb-back" onClick={back}>
          <ChevronLeft size={18} /> 返回
        </button>
        <div>
          <h2>{p.name}</h2>
          <p>{p.platform}</p>
        </div>
      </header>

      {/* hero 大分 */}
      <div className="pb-hero">
        <span className="pb-avatar lg">{p.name?.slice(0, 1) || "?"}</span>
        <div className="pb-hero-main">
          <div className="pb-hero-line">
            <span className={`pb-verdict v-${p.verdict}`}>{p.verdict}</span>
            {rank != null ? <span>排名 #{rank}</span> : null}
            <span>真实度 {p.truth_level || "未评"}</span>
          </div>
          <p className="pb-summary">{p.summary || "暂无总结"}</p>
        </div>
        <div className="pb-hero-score" style={{ color: intColor(iv) }}>
          <b>{iv}</b>
          <span>兴趣度</span>
        </div>
      </div>

      {gaps}

      {p.facts && Object.keys(p.facts).length > 0 && (
        <Section title="① 资料档案 · 事实层">
          <div className="pb-facts">
            {Object.entries(p.facts).map(([k, v]) => (
              <div key={k} className="pb-fact">
                <span>{k}</span>
                <b>{typeof v === "string" ? v : JSON.stringify(v)}</b>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="② 兴趣度六项分解"
        note="总分由六项相加得出（各满分不同），命中「社交平台幻觉型」或已止损时上限锁 30 分。"
      >
        <div className="pb-bd">{bdRows}</div>
      </Section>

      <Section title="③ 照片形象解码">{photos}</Section>

      <Section title="④ 真实性五维核验">{tc}</Section>

      <Section
        title="⑤ 没写在资料里的判断"
        note="每条四件套：证据链 + 置信度 + 至少两种解释 + 对你意味着。证据少于 2 项时置信度只能标「信息不足」。"
      >
        {inf}
      </Section>

      <Section title="⑥ 关系定位 · 机会与风险">{posBox}</Section>

      <Section title="⑦ 下一步方案">{planBox}</Section>

      <Section
        title={`⑧ 互动时间线（${p.timeline?.length ?? 0} 条）`}
        note="时间间隔硬门：间隔权重高于话术内容。间隔未知时禁止对兴趣度下结论。"
      >
        {tl}
      </Section>
    </section>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pb-section">
      <h3>{title}</h3>
      {children}
      {note ? <p className="pb-sect-note">{note}</p> : null}
    </div>
  );
}

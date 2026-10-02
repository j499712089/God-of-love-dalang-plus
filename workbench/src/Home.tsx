import { useState, type CSSProperties } from "react";
import { ArrowRight, Database, Heart, MessageCircle, Sparkles } from "lucide-react";

/** 售后微信号（点击复制） */
const SUPPORT_WX = "DLANG099";

/** 逐条入场动画的延迟（CSS 变量需断言） */
const d = (s: string) => ({ "--d": s }) as CSSProperties;

const STATS: { n: string; label: string }[] = [
  { n: "103", label: "条实战规则实时命中" },
  { n: "101", label: "个真实案例可追溯" },
  { n: "60", label: "组话术模板直接抄" },
  { n: "23:47", label: "夜间推进窗口在线" },
];

const FEATURES: { no: string; title: string; desc: string; tag: string }[] = [
  {
    no: "01",
    title: "微信聊天可视化分析",
    desc: "整屏截图 OCR 或直接粘贴文本，一分钟导入。逐句评估你的回复质量、她的情绪与意图，给出好感度评分与推进建议。",
    tag: "好感度 · 情绪 · 意图",
  },
  {
    no: "02",
    title: "女生档案库看板",
    desc: "为每个对象建立资料卡：社交平台截图 AI 识别建档，聊天与档案绑定，分析自动结合她的背景，跨平台查重防止认错人。",
    tag: "截图 AI 建档",
  },
  {
    no: "03",
    title: "大浪指导对话",
    desc: "基于云端恋爱策略库与她的档案，随时问大浪「下一步怎么回」——不给空话，直接给可复制的话术与接法。",
    tag: "直接给话术",
  },
];

const STEPS: { no: string; title: string; desc: string }[] = [
  { no: "1", title: "粘贴聊天", desc: "微信聊天整屏截图或复制文本，一键导入，谁说的点一下就行。" },
  { no: "2", title: "大浪分析", desc: "结合她的档案与云端实战库，逐句拆情绪、意图与你的回复质量。" },
  { no: "3", title: "照着回", desc: "拿到下一步动作与可复制话术，回完再把新消息丢进来接着看。" },
];

export default function Home({
  authed,
  email,
  onEnter,
}: {
  /** 是否已登录：未登录显示「注册 / 登录」，登录后出现「进入工作台」 */
  authed: boolean;
  email?: string;
  onEnter: () => void;
}) {
  // 售后按钮：点击复制微信号
  const [wxCopied, setWxCopied] = useState(false);
  const copyWx = () => {
    try {
      navigator.clipboard?.writeText(SUPPORT_WX);
    } catch {
      /* 忽略 */
    }
    setWxCopied(true);
    window.setTimeout(() => setWxCopied(false), 1600);
  };
  return (
    <div className="home">
      <header className="home-top">
        <div className="home-brand">
          <Heart size={19} className="home-brand-heart" />
          <span>恋爱之神 · 大浪工作台</span>
        </div>
        <button
          className="home-support"
          onClick={copyWx}
          title="售后支持 · 点击复制微信号"
        >
          <MessageCircle size={15} />
          {wxCopied ? "已复制，去微信添加" : "售后加微信 DLANG099"}
        </button>
        <button
          className={authed ? "home-enter authed" : "home-enter"}
          onClick={onEnter}
        >
          {authed ? "进入工作台" : "注册 / 登录"} <ArrowRight size={15} />
        </button>
      </header>

      <main>
        {/* ———— 首屏 ———— */}
        <section className="home-hero">
          <div className="home-hero-copy">
            <p className="home-eyebrow">云端恋爱推进工作台</p>
            <h1 className="home-title">
              把聊天记录交给大浪，
              <br />
              看清她的情绪，
              <br />
              <em>知道下一步怎么回</em>。
            </h1>
            <p className="home-sub">
              微信聊天可视化分析、女生档案库看板、大浪指导对话——不只告诉你她在想什么，直接给你可以照着发的下一句。
            </p>
            <div className="home-cta-row">
              <button className="home-cta" onClick={onEnter}>
                {authed ? "进入工作台" : "注册 / 登录"} <ArrowRight size={17} />
              </button>
            </div>
            {authed && (
              <p className="home-hello">
                已登录 <b>{email}</b> · 注册礼包已到账，点上方按钮进入工作台
              </p>
            )}
            <div className="home-gifts">
              <span className="home-gift">注册即送 <b>500 积分</b></span>
              <span className="home-gift">新号 <b>3 天</b>向量库试用</span>
              <span className="home-gift">¥1 = <b>100</b> 积分</span>
            </div>
            <div className="home-stack">
              <span className="home-stack-chip">
                <Sparkles size={14} /> GPT-5.6-SOL 深度推理大脑
              </span>
              <span className="home-stack-plus">+</span>
              <span className="home-stack-chip">
                <Database size={14} /> 大浪私有实战向量库 · 每条建议都有出处
              </span>
            </div>
          </div>

          {/* 装饰性演示窗口（纯展示，不承载交互） */}
          <aside className="home-chat" aria-hidden="true">
            <div className="home-chat-head">
              <span className="home-chat-dot" />
              她的聊天窗口 · 微信
              <span className="home-chat-time">周五 23:41</span>
            </div>
            <div className="home-chat-body">
              <div className="home-bubble other" style={d("0.2s")}>
                今天开会还被夸了，但是好累啊
                <span className="home-bubble-time">23:38</span>
              </div>
              <div className="home-bubble self" style={d("1.0s")}>
                辛苦啦，明天奖励自己一杯奶茶？
                <span className="home-bubble-time">23:40</span>
              </div>
              <div className="home-bubble other" style={d("1.8s")}>
                哈哈哈你怎么知道我想喝奶茶
                <span className="home-bubble-time">23:41</span>
              </div>
              <div className="home-verdict" style={d("2.7s")}>
                <Sparkles size={14} />
                <span>
                  <b>大浪</b>：情绪回暖，好感 ↑。下一句别问「在干嘛」，直接接「周六带你去喝那家新开的」。
                </span>
              </div>
            </div>
          </aside>
        </section>

        {/* ———— 数字条 ———— */}
        <section className="home-stats">
          {STATS.map((s) => (
            <div className="home-stat" key={s.label}>
              <b>{s.n}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </section>

        {/* ———— 能力 ———— */}
        <section className="home-sec">
          <div className="home-sec-head">
            <p className="home-sec-kicker">能力</p>
            <h2 className="home-sec-title">把「她在想什么」变成可以照做的下一步</h2>
          </div>
          <div className="home-features">
            {FEATURES.map((f) => (
              <article className="home-feature" key={f.no}>
                <span className="home-feature-no">{f.no}</span>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
                <span className="home-feature-tag">{f.tag}</span>
              </article>
            ))}
          </div>
        </section>

        {/* ———— 流程 ———— */}
        <section className="home-sec">
          <div className="home-sec-head">
            <p className="home-sec-kicker">流程</p>
            <h2 className="home-sec-title">三步上手，五分钟出第一份分析</h2>
          </div>
          <div className="home-steps">
            {STEPS.map((s) => (
              <article className="home-step" key={s.no}>
                <span className="home-step-no">{s.no}</span>
                <h4>{s.title}</h4>
                <p>{s.desc}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ———— 定价 ———— */}
        <section className="home-sec">
          <div className="home-sec-head">
            <p className="home-sec-kicker">定价</p>
            <h2 className="home-sec-title">先订阅向量库，再按量充积分</h2>
          </div>
          <div className="home-pricing-grid">
            <article className="home-price home-price-main">
              <span className="home-price-flag">分析的核心依据</span>
              <p className="home-price-kicker">第一步 · 订阅</p>
              <h3>向量库订阅</h3>
              <p className="home-price-num">
                ¥6.6<span>/ 月</span>
              </p>
              <ul>
                <li>分析与大浪指导的硬依据：实战规则与案例实时检索命中</li>
                <li>新用户注册即送 3 天完整试用，到期前随时续</li>
                <li>连订 3 / 6 / 12 个月享 9 折 – 8 折，不断档叠加</li>
              </ul>
              <button className="home-price-btn" onClick={onEnter}>
                订阅开通 <ArrowRight size={15} />
              </button>
            </article>
            <article className="home-price">
              <p className="home-price-kicker">第二步 · 按量充值</p>
              <h3>模型积分</h3>
              <p className="home-price-num">
                ¥1<span>= 100 积分</span>
              </p>
              <ul>
                <li>积分只算模型调用费用，按 token 用量计费</li>
                <li>注册即送 500 积分，先体验再决定充不充</li>
                <li>充 30 / 50 / 100 元有加赠，余额长期有效</li>
              </ul>
              <button className="home-price-btn" onClick={onEnter}>
                充值积分 <ArrowRight size={15} />
              </button>
            </article>
          </div>
        </section>
      </main>

      <footer className="home-foot">
        聊天记录保存在本机浏览器，分析时只发送所需片段给模型服务 · <b>恋爱之神 · 大浪工作台</b>
      </footer>
    </div>
  );
}

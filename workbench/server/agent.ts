import { AFFINITY_DIMENSIONS } from "../shared/affinity";
import { EMOTIONS } from "../shared/labels";
import { INTENTS } from "../shared/intents";
import { EVENT_KINDS } from "../shared/memory";
import { STAGES, ACTIONS, RELATIONS, type Relation } from "../shared/types";
import type { Retrieved } from "./vector";

const emotionKeys = Object.entries(EMOTIONS)
  .map(([k, v]) => `${k}(${v.label})`)
  .join("、");
const intentKeys = Object.entries(INTENTS)
  .map(([k, v]) => `${k}(${v.label})`)
  .join("、");
const eventKeys = Object.keys(EVENT_KINDS).join("、");
const stageKeys = Object.keys(STAGES).join("、");
const actionKeys = Object.keys(ACTIONS).join("、");
const affinityKeys = AFFINITY_DIMENSIONS.map(
  (d) => `${d.key}(${d.label})`,
).join("、");

const SYSTEM_BASE = `你是「恋爱之神大浪」，一位只给动作、不灌鸡汤的实战恋爱教练。你的任务：读一段微信聊天记录，输出结构化的分析（好感度、情绪、意图、回复评级、下一步动作与话术）。只依据给出的原话，禁止脑补线下关系、附件内容、对方性别或没出现的对话。

# 铁律（输出前逐条自检，违反即错）
1. 时间间隔优先：每条消息若有时间戳，先算间隔再看内容；间隔缺失就不对兴趣度下结论。
2. 阶段分流：公域（社交平台）以筛选、转私域为主；已转微信等私域，先建熟悉感（日常/生活/兴趣），熟悉够了再升温，不得跳过。
3. 废物测试不入座：前 3-15 轮很多句子是「测反应」不是「传信息」。对方说她的状态，就回她的状态；她没点名「我」，我不进画面。绝不自动报名、自证、加码、替她补完话。
4. 供给看成本不看话数：零成本（暧昧/玩笑/表情/名分）不计分；有成本（今天干了什么/工作琐事/烦心事/随手拍）计分；高成本（具体日期/语音/视频/见面）强计分。
5. 通道价值：文字 < 语音 < 视频 < 见面；经验越丰富，文字情绪越不值钱，目标是换通道。
6. 留白博弈：话术只给半句，保留回应空间；主动推进是给方向，不是替她说完。
7. 夜间窗口（21:30-02:00）：禁止劝睡、道晚安、「早点休息/明天聊」收线；她在情绪里就继续接，要收只用「下次钩子」收。
8. 边界尊重：对方明确拒绝、只做朋友、停止推进时，动作一律判「尊重边界」，好感度上限锁 25 分。
9. 关系内风险：涉及贵重礼物/借钱/大额付出前，先给「拿得到但要等」的时间轴看反应方向，不质问、不摊牌；苦情人设四红旗、多线并行只用于决策。
10. 输出纪律：只给动作指令（下一步只做一个动作：X），不写「你别焦虑」「压住反应」这类情绪指控。

# 话术形态（生成 next_reply 必守）
- 单条话术 1-2 个短句、约 5-10 字；超过 10 字必须拆成两条以上，用两个空格分段。
- 真人打字感，禁用书面腔（鉴于/综上/基于/旨在）和 AI 高频词（蛮、挺、还、倒是、说实话）。
- 唯一允许长文：需要画面感植入、展示高价值、或密集话术输出（50-100 轮才一次）。

# 下一句回复的生成顺序（先框架后话术）
先判断：①动能——不越界升温、不卑微追问，落在当前关系刻度；②字数——一句真人打字感；③信息探测——带具体名词钩子（时间/地点/职业/经历）。再给话术。`;

function formatRetrieved(r: Retrieved): string {
  const parts: string[] = [];
  if (r.rules.length) {
    parts.push("## 命中的规则（硬约束，直接适用）");
    for (const x of r.rules) {
      parts.push(
        `- [${x.category ?? x.id ?? "规则"}] ${x.text ?? x.rule}${
          x.explanation ? ` —— ${x.explanation}` : ""
        }`,
      );
    }
  }
  if (r.strategies.length) {
    parts.push("## 用户的同场景实战策略（学决策链，不抄句子）");
    for (const x of r.strategies) {
      if (x.text && !x.title) {
        parts.push(`- [${x.id ?? "策略"}] ${x.text}`);
        continue;
      }
      parts.push(`- 【${x.title ?? "策略"}】${x.window_10 ?? ""}`);
      const moves = Array.isArray(x.your_moves) ? x.your_moves : [];
      for (const m of moves.slice(0, 3)) {
        if (typeof m === "object" && m) {
          const mm = m as Record<string, unknown>;
          parts.push(`    - 触发「${mm.trigger ?? ""}」→ 动作「${mm.action ?? ""}」（${mm.why ?? ""}）`);
        }
      }
      if (x.result) parts.push(`    - 结果：${x.result}`);
    }
  }
  if (r.cases.length) {
    parts.push("## 相似案例（前置条件须与当前匹配，勿机械套用）");
    for (const x of r.cases.slice(0, 3)) {
      if (x.text && !x.situation) {
        parts.push(`- [${x.id ?? "案例"}]（相似度 ${x.score ?? "?"}）${x.text}`);
        continue;
      }
      parts.push(
        `- 场景：${x.situation ?? ""}\n  判断：${x.analysis ?? ""}\n  建议：${x.recommendation ?? ""}`,
      );
    }
  }
  if (r.templates.length) {
    parts.push("## 推荐话术模板（改造成你自己的，别照抄）");
    for (const x of r.templates.slice(0, 3)) {
      if (x.text && !x.scenario) {
        parts.push(`- [${x.id ?? "话术"}]（相似度 ${x.score ?? "?"}）${x.text}`);
        continue;
      }
      parts.push(
        `- 场景：${x.scenario ?? ""} → 「${x.template ?? ""}」${x.explanation ? `（${x.explanation}）` : ""}`,
      );
    }
  }
  return parts.length ? parts.join("\n\n") : "";
}

export function buildSystemPrompt(
  retrieved: Retrieved,
  relation: Relation,
  profileSummary?: string,
): string {
  const block = formatRetrieved(retrieved);
  return [
    SYSTEM_BASE,
    `# 当前关系设定：${RELATIONS[relation]}`,
    block ? `# 向量库检索结果（本场景相关知识，优先采纳）\n${block}` : "",
    profileSummary
      ? `# 她的资料卡（档案库实档，判断必须结合这份档案；聊天新信息与档案冲突时指出冲突）\n${profileSummary}`
      : "",
    `# 输出格式
你必须只输出一个 JSON 对象，不要任何解释、注释或 markdown 代码块。字段名与枚举值严格按 user 消息里的 schema。数值字段用数字，概率用 0-1 的小数，数组用 []。情绪/意图/事件/阶段/动作的取值必须来自下列枚举：
- 情绪 key：${emotionKeys}
- 意图 key：${intentKeys}
- 事件 key：${eventKeys}
- 阶段 key：${stageKeys}
- 动作 key：${actionKeys}
- 好感度六维 key：${affinityKeys}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildUserPrompt(
  input: {
    task: string;
    relation: Relation;
    messages: { id: string; sender: string; text: string; timestamp?: string | null }[];
    targetIds: string[];
  },
): string {
  // 时间戳放 user prompt（而非 system prompt），保持 system prompt 前缀稳定以命中 prompt cache
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const nightWindow =
    (now.getHours() >= 21 && now.getMinutes() >= 30) ||
    now.getHours() >= 22 ||
    now.getHours() < 2;
  const timeNote = `# 当前时间：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${hhmm}（周${week}${nightWindow ? "，正处于夜间推进窗口 21:30-02:00：禁止劝睡收线" : ""}）。判读回复间隔、时间窗（同日/跨日/失联多日）必须用消息时间戳与当前时间的差值。`;
  const lines = input.messages
    .map((m, i) => {
      const who = m.sender === "self" ? "我" : "对方";
      const ts = m.timestamp ? ` [${m.timestamp}]` : "";
      return `#${i} ${who}${ts}：${m.text}`;
    })
    .join("\n");

  const targetNote =
    input.targetIds.length > 0
      ? `需要逐条分析的目标消息编号：${input.targetIds.join(", ")}`
      : "这是一次整体判断（overview），不逐条输出。";

  const schema =
    input.task === "overview"
      ? `请输出 JSON：
{
  "affinity": {"initiative": 0, "engagement": 0, "care": 0, "openness": 0, "intimacy": 0, "action": 0},
  "affinity_confidence": 0.7,
  "boundary": 0,
  "stage": "flow",
  "action": "continue",
  "pending": 0,
  "evidence": null,
  "action_evidence": null,
  "next_reply": "下一句话术（可含两个空格分段）",
  "next_reply_note": "为什么这么说（一句话）",
  "risks": ["风险点"],
  "note": "一句话总结当前关系状态",
  "five_step": {
    "emotion": "情绪落地：2-4句点出对方感受与触发点",
    "facts": "事实拆分：①截图能证明 ②仅转述 ③未知缺失，矛盾指出、缺失保持未知",
    "interest": "利益判断：互惠/可靠/吸引/价值观/现实可行性/机会成本",
    "advice": "明确建议：一句首选 + 2-4个理由 + 最多3版（稳健/会撩/强势）",
    "action": "行动收束：现在能做的小动作 + 观察窗口 + 值得回来反馈的具体信号"
  },
  "rounds": [
    {"round": 1, "goal": "本轮只定一个目标（承接/降压/调侃/轻推/约见/澄清/收线）", "reply": "本轮话术（≤10字拆条）", "watch": "观察她什么反应", "if_good": "她接/正向→下一步", "if_cold": "她冷淡/不接→怎么办", "if_shift": "她转话题→怎么办"},
    {"round": 2, "goal": "...", "reply": "...", "watch": "...", "if_good": "...", "if_cold": "...", "if_shift": "..."}
  ]
}
字段说明：affinity 六维每维 0-100（只评对方对我的接近程度，近期明确表达优先于早期信号）；affinity_confidence 是整体置信度 0-1；boundary 是「对方存在仍有效的拒绝边界」的概率 0-1（≥0.8 时好感度会被锁 25 分）；stage 是关系里程碑；action 是下一步动作；pending 是「最后一条是我发的、该等对方接球」的概率 0-1；evidence/action_evidence 填最能支撑判断的消息编号（#数字，没有填 null）；next_reply 是给我方的下一句回复（一句话）；five_step 是五步分析链路（每步一段，直接给结论不写空话）；rounds 是下面 1-3 轮的推进路线，每轮 round 从 1 递增，goal 只定一个目标，reply 是可直接复制的话术（≤10 字拆条、真人打字感、两个空格分段），watch/if_good/if_cold/if_shift 是这一轮对方不同反应的接法。rounds 至少给 1 轮、最多 3 轮，别堆到每轮一个动作以上。`
      : input.task === "other_messages"
        ? `请输出 JSON：
{
  "lines": [
    {"id": "#3", "event": "care", "emotions": {"happy": 0.6, "calm": 0.3}, "intents": {"share": 0.7, "answer": 0.2}}
  ]
}
字段说明：对每个目标消息，id 填消息编号；event 是该消息值得保留的事件类别（无则 none）；emotions 是主要情绪候选分布（key 用情绪枚举，概率之和不必为 1，只给 top 2-3）；intents 是主要沟通意图候选分布（区分情绪与意图，日常回答/分享/接话也是有效意图，有证据才选暧昧类）。`
        : `请输出 JSON：
{
  "lines": [
    {"id": "#2", "score": 70, "confidence": 0.7, "enough": "sufficient", "comment": "一句话点评"}
  ]
}
字段说明：对每个目标消息（sender=我），score 是我方该回复在「发出时」的表达质量 0-100；confidence 是置信度 0-1；enough 是证据充分度（sufficient/limited/insufficient）；comment 是一句话点评。只评表达质量，不评追求成败。`;

  return `${timeNote}

# 聊天记录（${input.messages.length} 条）
${lines}

# 任务
${targetNote}

# 需要输出的 JSON 结构
${schema}`;
}

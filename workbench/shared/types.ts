import type { MemoryEvent, MemoryUpdate } from "./memory";
import type { AffinityDimension } from "./affinity";
export type Relation = "crush" | "new" | "couple";
export type Message = {
  id: string;
  sender: "self" | "other";
  text: string;
  timestamp: string | null;
  kind: "text" | "unreadable" | "image";
  /** 图片消息的原图 dataUrl（kind="image" 时渲染缩略图；分析请求会剥离，不进模型） */
  imageUrl?: string;
};
export type Parsed = {
  speaker: string;
  text: string;
  timestamp: string | null;
};
export type Judgment = {
  value: number | null;
  confidence: number;
  status: "clear" | "ambiguous" | "insufficient";
  probabilities: Record<string, number>;
};
export type LineResult = {
  event?: { kind: MemoryEvent["kind"]; confidence: number };
  skipped?: string;
  id: string;
  score: Judgment;
  emotions?: Record<string, number>;
  intents?: Record<string, number>;
  replyType?: string;
  replyConfidence?: number;
  tone?: string;
  tones?: Record<string, number>;
  toneConfidence?: number;
};
export type Overview = {
  memoryEvidenceIds?: string[];
  contextCount?: number;
  affinity: Judgment;
  affinityDimensions?: AffinityDimension[];
  affinityRawValue?: number;
  boundaryApplied?: boolean;
  stage: string;
  rapport?: Judgment;
  action: string;
  alternative?: string;
  evidenceId: string | null;
  actionEvidenceId: string | null;
  nextReply?: string;
  nextReplyNote?: string;
  risks?: string[];
  note?: string;
  /** 下面几轮的推进路线（§5 私域：连续推进 1-3 轮，每轮目标+话术+反应分支） */
  rounds?: RoundPlan[];
  /** 五步链路（§4.1：情绪落地→事实拆分→利益判断→明确建议→行动收束） */
  fiveStep?: FiveStep;
};

/** 私域推进路线的一轮：目标 + 话术 + 对方反应的三种分支。 */
export type RoundPlan = {
  round: number;
  /** 本轮只定一个目标（承接/降压/调侃/轻推/约见/澄清/收线） */
  goal: string;
  /** 本轮可复制话术（≤10 字拆条） */
  reply: string;
  /** 观察对方什么反应 */
  watch?: string;
  /** 她接/正向 → 怎么做 */
  ifGood?: string;
  /** 她冷淡/不接 → 怎么做 */
  ifCold?: string;
  /** 她转话题 → 怎么做 */
  ifShift?: string;
};

/** 五步链路（§4.1）。 */
export type FiveStep = {
  emotion: string;
  facts: string;
  interest: string;
  advice: string;
  action: string;
};

/** 公域开场白（§5 开场分流：有通道=Hi / 无通道高搭话=一句话开场）。 */
export type OpenerPlan = {
  channel: "matched" | "cold";
  /** 可复制开场白 */
  opener: string;
  /** 为什么这么开场 */
  reason: string;
  /** 对方不同反应的分支判断 */
  branches: { trigger: string; move: string }[];
};
export type Snapshot = {
  revision: number;
  messages: Message[];
  lines: Record<string, LineResult>;
  overview: Overview;
  relation: Relation;
  at: string;
  latencyMs: number;
  source: "live" | "fixture";
  comparable: boolean;
};
export type Task = "overview" | "other_messages" | "self_message";
/** 录入区贴的图片（已压缩成 dataURL），供视觉模型读取分析。 */
export type AnalysisImage = {
  id: string;
  name?: string;
  /** dataURL（含 mime 前缀），只收 image/jpeg|png|webp */
  dataUrl: string;
};
/** 单张图片的视觉分析结论。 */
export type ImageInsight = {
  imageId: string;
  /** 穿搭/风格标签，如「学院风」「 clean fit 」 */
  tags: string[];
  /** 场景/生活状态线索，如「健身房自拍」「下午茶探店」 */
  scene?: string;
  /** 真实性评估：生活照 / 精修 / 疑似网图 / 疑似AI生成 等 */
  authenticity?: string;
  note: string;
};
/** 社交平台资料截图的 AI 提取结果（前端可编辑后再落库建档）。 */
export type ExtractedProfile = {
  platform: string;
  nickname: string;
  age: string;
  city: string;
  occupation: string;
  income: string;
  bio: string;
  interests: string[];
  /** 照片整体印象：穿搭风格、场景、气质 */
  photosSummary: string;
  /** 真实性评估 + 依据 */
  authenticity: string;
  /** 资料疑点（简介模板化/职业与照片矛盾/引流等） */
  redFlags: string[];
  /** 给恋爱分析的综合备注 */
  notes: string;
  /** 可核实的具体事实（{item, value}，直接可入档案 facts） */
  facts: { item: string; value: string }[];
  /** 逐张照片的客观深读（视觉模型读出的画面/穿搭/场景/姿态） */
  photoObservations: PhotoObservation[];
  /** 深层综合分析（主模型 + 向量库方法论）：穿搭心理/人设经营/没说的推断/待确认/机会风险 */
  deep: DeepAnalysis | null;
};

/** 单张资料截图的客观读图结果（第一阶段视觉模型输出，只描述、少推断）。 */
export type PhotoObservation = {
  /** 全局序号（从 1 起，跨分批连续） */
  no: number;
  /** 类型：资料页 / 生活照 / 自拍 / 合影 / 动态截图 / 其他 */
  kind: string;
  /** 画面要点：内容 + 图上可见文字 + 细节信号（物品/背景/消费线索/生活状态） */
  content: string;
  /** 穿搭细节：风格/颜色/单品/质感 */
  dress: string;
  /** 场景：在哪拍的/什么场合 */
  scene: string;
  /** 姿态与表情 */
  pose: string;
  /** 深解读（第二阶段补全）：这张照片在传达什么/经营什么人设/修图质感 */
  decode: string;
};

/** 资料没写的判断（对齐档案卡 inferences 四件套纪律）。 */
export type InferenceItem = {
  /** 推断标题，如「收入自述存疑」 */
  title: string;
  /** 高 / 中 / 低 / 信息不足（证据链 <2 项必须为「信息不足」） */
  confidence: string;
  /** 证据：从资料/照片里指认的具体依据 */
  evidence: string;
  /** 至少两种解读（A/B 视角），防单证据下结论 */
  readings: string[];
  /** 手段/应对：这条推断对推进策略意味着什么 */
  means: string;
};

/** 第二阶段深层综合分析（对齐档案卡模板的深层字段）。 */
export type DeepAnalysis = {
  /** 穿搭心理分析：审美取向、自我呈现策略、消费暗示、性格投射 */
  dressPsychology: string;
  /** 人设经营解读：资料想让你看到什么、刻意回避什么 */
  personaRead: string;
  /** 真实性总结（2-3 句） */
  truthNote: string;
  /** 真实性五维（dim/result/level），level ∈ 高/中-高/中/中-低/低 */
  truthCheck: { dim: string; result: string; level: string }[];
  /** 资料没写的深层推断（≥3 条，四件套） */
  inferences: InferenceItem[];
  /** 待确认变量（信息缺口） */
  gaps: string[];
  /** 机会点 */
  chance: string[];
  /** 风险点 */
  risk: string[];
};
/** 聊天截图 OCR 转出的单行对话。side = 气泡在屏幕的哪一边。 */
export type OcrLine = {
  side: "left" | "right";
  /** AI 读到的说话人昵称（对方显示昵称就填，机主为空） */
  speakerGuess: string;
  text: string;
  /** 消息时间（截图上有就填，如 "20:32"） */
  time: string;
  /** 消息类型：text=文字气泡，image=图片消息（此时 text 为图片内容描述） */
  kind?: "text" | "image";
  /** 图片内容描述（kind=image 时）：拍的是什么/什么场景/图上写了什么字 */
  imageDesc?: string;
};
/** 聊天截图 OCR 结果。 */
export type OcrChatResult = {
  lines: OcrLine[];
  /** 气泡布局判读说明（如「右侧绿色气泡为机主发出」） */
  layoutNote: string;
};
export type AnalysisRequest = {
  memory?: Pick<MemoryEvent, "id" | "kind" | "status" | "resolvedBy">[];
  revision: number;
  relation: Relation;
  messages: Message[];
  task: Task;
  targetIds: string[];
  /** 已匹配的资料卡 id：命中时分析会结合她的档案综合判断 */
  profileId?: string;
  /** 附带图片（仅总览任务使用）：对方照片 / 朋友圈截图 / 资料页截图 */
  images?: AnalysisImage[];
};
export type RetrievalHitRef = { type: string; id: string; score: number };
export type AnalysisResponse = {
  memoryUpdates?: MemoryUpdate[];
  revision: number;
  contextHash: string;
  model: string;
  rubricVersion: string;
  overview?: Overview;
  lines?: LineResult[];
  /** 图片视觉分析结论（有图且总览任务时返回） */
  imageInsights?: ImageInsight[];
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  retrievalHits?: RetrievalHitRef[];
};
export const MODEL = "dalang-relay";
export const RUBRIC = "dalang-1.0.0";
export const RELATIONS: Record<Relation, string> = {
  crush: "暧昧中",
  new: "刚认识",
  couple: "恋爱中",
};
export const TONES: Record<string, string> = {
  warm: "关心靠近",
  playful: "俏皮试探",
  neutral: "平静交流",
  polite: "礼貌客气",
  upset: "不满委屈",
  closing: "回避收尾",
  unknown: "难以判断",
};
export const STAGES: Record<string, string> = {
  unknown: "信息不足",
  contact: "刚搭上线",
  flow: "聊得起来",
  flirt: "出现暧昧",
  date: "有具体约会安排",
  mutual: "明确互表心意",
};
export const ACTIONS: Record<string, { label: string; detail: string }> = {
  continue: { label: "顺着聊", detail: "接住刚才的话题，别急着切换频道。" },
  ask: {
    label: "轻轻追问",
    detail: "问一个具体、容易回答的小问题，把球轻轻递过去。",
  },
  empathize: {
    label: "先接情绪",
    detail: "先回应对方的感受，再考虑讲道理或给建议。",
  },
  flirt: {
    label: "轻轻调情",
    detail: "顺着已经被接住的玩笑，留一点刚刚好的暧昧。",
  },
  invite: {
    label: "试着约一下",
    detail: "把共同兴趣变成一个具体、没有压力的小邀约。",
  },
  clarify: {
    label: "直接问清",
    detail: "这句话有不止一种理解，温和确认比反复猜更有效。",
  },
  wait: {
    label: "等对方接球",
    detail: "球已经递出去了。先留一点空间，不用急着补发。",
  },
  close: {
    label: "今天先收尾",
    detail: "让聊天停在舒服的位置，下次还有话可说。",
  },
  respect: {
    label: "尊重边界",
    detail: "对方表达了拒绝或需要空间。尊重这个意思，停止推进。",
  },
  insufficient: {
    label: "再多一点上下文",
    detail: "这几句话还看不准，补上前后文再一起看看。",
  },
};
export function grade(n: number | null) {
  return n === null
    ? "看不准"
    : n >= 80
      ? "妙"
      : n >= 60
        ? "稳"
        : n >= 40
          ? "一般"
          : n >= 20
            ? "有点尬"
            : "刹车";
}
export function affinityLabel(n: number | null) {
  return n === null
    ? "心动信号，等待接收"
    : n >= 80
      ? "心动信号拉满"
      : n >= 60
        ? "有点来电"
        : n >= 40
          ? "有来有回"
          : n >= 20
            ? "比较克制"
            : "信号偏弱";
}
export function statusLabel(j?: Judgment) {
  return !j || j.status === "insufficient"
    ? "信息不足"
    : j.status === "clear"
      ? "判断较明确"
      : "有歧义";
}
export function meanQuality(
  messages: Message[],
  lines: Record<string, LineResult>,
) {
  const v = messages
    .filter((m) => m.sender === "self")
    .map((m) => lines[m.id]?.score.value)
    .filter((x): x is number => typeof x === "number");
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
export function contextKey(messages: Message[], relation: Relation) {
  return JSON.stringify({
    model: MODEL,
    rubric: RUBRIC,
    relation,
    messages: messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      text: m.text,
      timestamp: m.timestamp,
      kind: m.kind,
    })),
  });
}

export function requestContextKey(input: AnalysisRequest) {
  return (
    contextKey(input.messages, input.relation) +
    JSON.stringify(
      (input.memory ?? []).map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        resolvedBy: e.resolvedBy,
      })),
    )
  );
}

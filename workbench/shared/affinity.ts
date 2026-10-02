import type { Judgment } from "./types";
export const AFFINITY_DIMENSIONS = [
  {
    key: "initiative",
    label: "主动延续",
    weight: 15,
    question: "other 是否主动开启或延续与 self 的交流？不要靠消息条数推断。",
    levels: [
      "明确不愿继续交流",
      "有交流机会但只被动应付或反复终止话题",
      "自然接话，愿意保持交流",
      "主动追问、展开话题或在结束后重新找话题",
      "持续主动创造交流机会，并具体表达想与 self 保持联系",
    ],
  },
  {
    key: "engagement",
    label: "回应投入",
    weight: 20,
    question:
      "other 对 self 说的具体内容投入了多少注意与回应？短句、回复慢、忙碌本身不扣分。",
    levels: [
      "明确无视或贬低 self 的表达",
      "多次有回应机会却回避重点、只作敷衍应答",
      "正常回应问题，基本接得住话题",
      "回应细节、接住玩笑或认真展开 self 的话题",
      "持续专注地理解和回应 self，主动跟进此前提到的具体事情",
    ],
  },
  {
    key: "care",
    label: "关心体贴",
    weight: 20,
    question:
      "other 是否针对 self 的感受、需要和处境表达个人化关心？礼貌客套与具体关心分开判断。",
    levels: [
      "明确嘲弄或漠视已表达的困难和感受",
      "在 self 表达需要时明显不愿回应或只敷衍",
      "普通礼貌与基本照顾，未见针对个人的特别关心",
      "具体理解、安慰 self，记得其偏好或困扰",
      "主动持续照顾 self 的感受和需要，并提供具体支持",
    ],
  },
  {
    key: "openness",
    label: "自我开放",
    weight: 15,
    question:
      "other 是否愿意让 self 了解自己的生活、感受和个人想法？正常隐私边界不是疏远。",
    levels: [
      "明确拒绝让 self 了解自己并要求保持距离",
      "有相关话题但刻意保持非常表面的交流",
      "自然分享一般日常与观点",
      "主动分享个人细节、真实感受或寻求 self 的看法",
      "展现明显信任，主动分享脆弱感受、重要经历或内心想法",
    ],
  },
  {
    key: "intimacy",
    label: "亲密表达",
    weight: 20,
    question:
      "other 是否对 self 表达被双方接纳的特别亲近或恋爱意味？朋友间热闹、通用表情、普通夸奖不自动等于暧昧。情侣也需看当前实际表达，不按关系设置加分。",
    levels: [
      "明确拒绝恋爱或亲密接近，且当前仍有效",
      "明确限定普通关系、排除暧昧意味",
      "友好自然但没有明确恋爱意味，或亲近暗示尚不确定",
      "有针对 self 的特别称赞、想念、亲昵称呼或被接住的暧昧",
      "明确表达恋爱喜欢、爱意或双方接纳的亲密愿望",
    ],
  },
  {
    key: "action",
    label: "实际行动",
    weight: 10,
    question:
      "other 是否愿意把接近 self 落实为时间安排或具体行动？没有邀约机会不等于拒绝。因忙改期且给出替代安排是积极信号。",
    levels: [
      "明确拒绝进一步接触，且没有替代意愿",
      "有推进机会却反复含糊回避或拒绝且无替代安排",
      "只谈一般可能性，或这段聊天尚未涉及具体行动",
      "主动提出、接受具体相处安排，或没空但积极给出替代安排",
      "双方具体安排得到确认，或有直接文字证据表明已兑现关心与相处行动",
    ],
  },
] as const;
export type AffinityDimension = {
  key: string;
  label: string;
  weight: number;
  judgment: Judgment;
};
export function composeAffinity(
  dimensions: AffinityDimension[],
  boundary: number,
) {
  const total = dimensions.reduce((s, d) => s + d.weight, 0);
  if (!total || dimensions.some((d) => d.judgment.value === null))
    throw new Error("好感维度缺失");
  const rawValue = Math.round(
    dimensions.reduce((s, d) => s + d.weight * d.judgment.value!, 0) / total,
  );
  const confidence =
    dimensions.reduce((s, d) => s + d.weight * d.judgment.confidence, 0) /
    total;
  const status = dimensions.some((d) => d.judgment.status === "insufficient")
    ? "insufficient"
    : dimensions.some((d) => d.judgment.status === "ambiguous")
      ? "ambiguous"
      : "clear";
  const boundaryApplied = boundary >= 0.8;
  return {
    affinity: {
      value: boundaryApplied ? Math.min(25, rawValue) : rawValue,
      confidence,
      status,
      probabilities: {},
    } as Judgment,
    rawValue,
    boundaryApplied,
  };
}

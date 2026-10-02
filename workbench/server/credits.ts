import { getUserById, saveUser } from "./auth";
import { LOCAL_MODE } from "./config";

// ---------- 定价常量（分 / 1K token） ----------
// 🔴 2026-09-27 定价铁律（主人定板）：输入 / 输出 / 缓存命中 / 缓存未命中(写入)
// 四档都必须「高于上游分组成本」，总体控制在 ~2.5 倍售价（原 4 倍用户嫌高，降到 2.5 倍）。
// 🔴 2026-10-01 主人纠偏（重要，别再犯）：GPT 的上游是中转站（Found.AI），它的「美刀」
//   不是真美元，是网站积分——**¥1.38 人民币 = 1 美刀（网站积分）**。所以 GPT 定价
//   不适用「真实美元汇率」逻辑，¥7.2/$ 是定价锚（商业决策），不是汇率换算。
//   今日曾误把 GPT 也按真实汇率 ¥7.0 重算（1.81/0.22/8.7），主人要求改回原样：
//   GPT 下游用户（大浪指导/截图分析等重度 GPT 功能）计费保持定板原值不动。
//   Jev 的上游（TypeSafe）才是真美元，¥7.0 只用于 Jev。
//
// 上游 = Found.AI「发现未来·GPT稳定组 0.165x」（工作台 key「电脑1」所在组），
// gpt-5.6-sol 基础价 = 输入 $5/M、输出 $30/M、缓存命中 $0.75/M、缓存写入 $6.25/M（积分美刀计价）：
//   组内成本（¥7.2/$ 定价锚，每 1K）：输入 0.594分 · 缓存命中 0.089分 · 缓存写入 0.743分 · 输出 3.564分
// 注意：relay 只上报「缓存命中」token（cached_tokens），缓存写入 token 对工作台不可见，
// 已并入「输入」桶（input_tokens - cache_hit_tokens）。故「输入」档锚定写入成本 0.743 分 ×2.5 = 1.86，
// 取 1.9 分（写入档 2.56x、纯输入 3.20x）；缓存 0.229 → 0.23（2.58x）；输出 3.564 ×2.5 = 8.91 → 9.0（2.52x）。
// 四档全部 ≥2.5x 上游成本，总毛利 ≈ 售价的 60%（毛利 1.5 倍成本）。
export const INPUT_PER_K = 1.9; // 输入（含缓存未命中写入）：1.9 分/1K = ¥19/M（≥写入 2.56x）
export const CACHE_PER_K = 0.23; // 缓存命中：0.23 分/1K = ¥2.3/M（2.58x）
export const OUTPUT_PER_K = 9; // 输出：9 分/1K = ¥90/M（2.52x）

// ---------- Jev（TypeSafe System One）定价（2026-10-01 主人定板「费用=上游两倍」） ----------
// 上游 = TypeSafe：$0.042/M 输入、输出免费。⚠️ Jev 的美刀是真美元（信用卡/Stripe 结算），
// 与 GPT 的「积分美刀（¥1.38）」完全不同，汇率锚 ¥7.0/$（真实牌价约 ¥6.7 + 购汇点差缓冲）。
// 两倍 → 输入 $0.084/M、输出仍免费。换算链（同时折算「汇率」+「充值比例」）：
//   $0.084/M × ¥7.0/$ = ¥0.588/M ÷ 1000 = ¥0.000588/1K × 100 分/元 = 0.0588 分/1K
// 输出免费、无缓存概念。ceil 保证每笔 ≥1 分（一次批量判断 ≈ 1 分，几乎可忽略，远低于 GPT 逐条分析）。
export const JEV_INPUT_PER_K = 0.0588; // 0.0588 分/1K = 2x 上游输入成本（$0.084/M）

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  /** 缓存命中的 token 数（从 input_tokens 中拆出，按 0.15 折算） */
  cache_hit_tokens?: number;
};

/** 余额不足时抛出，供路由返回 402。 */
export class InsufficientCreditsError extends Error {
  constructor() {
    super("积分不足");
    this.name = "InsufficientCreditsError";
  }
}

/**
 * 按 ceil 向上取整折算积分。
 * 规则：缓存命中 token（cache_hit_tokens）从 input_tokens 中拆出，
 * 缓存部分按 CACHE_PER_K、其余输入按 INPUT_PER_K、输出按 OUTPUT_PER_K 折算。
 */
export function computeCost(usage: Usage): number {
  const cached = Math.max(0, Math.floor(usage.cache_hit_tokens ?? 0));
  const input = Math.max(0, usage.input_tokens - cached);
  const output = Math.max(0, usage.output_tokens);
  return (
    Math.ceil((input / 1000) * INPUT_PER_K) +
    Math.ceil((cached / 1000) * CACHE_PER_K) +
    Math.ceil((output / 1000) * OUTPUT_PER_K)
  );
}

/** 扣费：余额不足抛 InsufficientCreditsError（路由据此返回 402）。单机模式不扣费。 */
export function deductCredits(
  userId: string,
  usage: Usage,
): { credits: number; cost: number } {
  if (LOCAL_MODE) return { credits: 0, cost: 0 };
  const user = getUserById(userId);
  if (!user) throw new InsufficientCreditsError();
  const cost = computeCost(usage);
  if (user.credits < cost) throw new InsufficientCreditsError();
  user.credits -= cost;
  saveUser(user);
  return { credits: user.credits, cost };
}

/** Jev 快速判断扣费：只按输入 token 计费（输出免费），ceil 保证每笔 ≥1 分。 */
export function computeJevCost(usage: Usage): number {
  const input = Math.max(0, Math.floor(usage.input_tokens));
  return Math.max(1, Math.ceil((input / 1000) * JEV_INPUT_PER_K));
}

export function deductJevCredits(
  userId: string,
  usage: Usage,
): { credits: number; cost: number } {
  if (LOCAL_MODE) return { credits: 0, cost: 0 };
  const user = getUserById(userId);
  if (!user) throw new InsufficientCreditsError();
  const cost = computeJevCost(usage);
  if (user.credits < cost) throw new InsufficientCreditsError();
  user.credits -= cost;
  saveUser(user);
  return { credits: user.credits, cost };
}

export function getBalance(userId: string): number {
  // 单机模式返回无限余额：precheckCredits 的 getBalance>=cost 恒真，永不因积分不足拦截。
  if (LOCAL_MODE) return Infinity;
  return getUserById(userId)?.credits ?? 0;
}

/** 充值入账：给用户加积分，返回新余额。金额向下取整，负数不生效。 */
export function addCredits(userId: string, amount: number): number {
  const user = getUserById(userId);
  if (!user) throw new Error("用户不存在");
  user.credits += Math.max(0, Math.floor(amount));
  saveUser(user);
  return user.credits;
}

/** 管理端调账：delta 可正可负，向下取整，余额下限 0。返回新余额。 */
export function adjustCredits(userId: string, delta: number): number {
  const user = getUserById(userId);
  if (!user) throw new Error("用户不存在");
  user.credits = Math.max(0, user.credits + Math.floor(delta));
  saveUser(user);
  return user.credits;
}

// ---------- 调用前估算（用于「调用前校验余额足够」） ----------
// 中文约 1 token/字，其它字符约 1 token/4 字符；图片按每张固定估算。
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[㐀-䶿一-鿿豈-﫿＀-￯]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateUsage(text: string, imageCount = 0): Usage {
  const input = estimateTokens(text) + imageCount * 1200;
  // 输出按输入 1:1 高估，确保「调用前校验」覆盖绝大多数实际用量，避免调用后才发现余额不足
  return { input_tokens: input, output_tokens: input, cache_hit_tokens: 0 };
}

export function estimateCost(usage: Usage): number {
  return computeCost(usage);
}

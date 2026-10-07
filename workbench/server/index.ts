import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { analyze } from "./analysis";
import { testJev } from "./jev";
import { loadConfig, saveConfig, publicConfig, LOCAL_MODE, type AppConfig } from "./config";
import { vectorService } from "./vector";
import { chatCompletion, type TokenUsage, type ChatMessage } from "./relay";
import { extractProfile, ocrChat, synthesizeDeep, generateOpener } from "./vision";
import * as profile from "./profile";
import {
  authMiddleware,
  registerUser,
  loginUser,
  getUserById,
  AuthError,
} from "./auth";
import {
  deductCredits,
  deductJevCredits,
  getBalance,
  estimateUsage,
  estimateCost,
  InsufficientCreditsError,
  INPUT_PER_K,
  CACHE_PER_K,
  OUTPUT_PER_K,
  type Usage,
} from "./credits";
import { EVENT_KINDS } from "../shared/memory";
import { MAX_MESSAGES, MAX_TEXT_CHARS } from "../shared/limits";
import { createNativeOrder, verifyAndDecrypt } from "./wechatPay";
import { adminRouter } from "./admin";
import {
  RECHARGE_PACKAGES,
  getPackage,
  createOrder,
  getOrder,
  listOrders,
  settleOrder,
  purgeExpiredPendingOrders,
  VECTOR_PACKAGES,
  getVectorPackage,
  createVectorOrder,
} from "./orders";
import {
  getVectorStatus,
  issueVectorKey,
  hasVectorAccess,
  findUserByVectorKey,
} from "./vectorAccess";

const __dirname = dirname(fileURLToPath(import.meta.url));

const requestSchema = z
  .object({
    memory: z
      .array(
        z.object({
          id: z.string().max(80),
          kind: z.enum(
            Object.keys(EVENT_KINDS) as [
              keyof typeof EVENT_KINDS,
              ...(keyof typeof EVENT_KINDS)[],
            ],
          ),
          status: z.enum(["active", "resolved", "uncertain"]),
          resolvedBy: z.string().max(80).optional(),
        }),
      )
      .max(12)
      .optional(),
    revision: z.number().int().nonnegative(),
    relation: z.enum(["crush", "new", "couple"]),
    task: z.enum(["overview", "other_messages", "self_message"]),
    targetIds: z.array(z.string().max(80)).max(20),
    messages: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          sender: z.enum(["self", "other"]),
          text: z
            .string()
            .min(1)
            .refine((t) => Array.from(t).length <= MAX_TEXT_CHARS),
          timestamp: z.string().max(80).nullable(),
          // 🔴 2026-10-01 修复「聊天结构或长度不符合要求」：前端 9-30 起支持「[图片] 占位+附图
          // 自动识别」，toMessages 会产出 kind:"image" 的消息（text=占位/识别描述，必非空）。
          // 逐条分析的上下文窗口只要含一条 image 消息（哪怕不是分析目标）就会被这里的旧枚举
          // 拒掉 → 400。补上 "image"。排查口诀：先看这行枚举，再怀疑长度（12,000 字 / 500 条）。
          kind: z.enum(["text", "unreadable", "image"]),
        }),
      )
      .min(1)
      .max(MAX_MESSAGES),
    profileId: z.string().max(80).optional(),
    // 附带图片（仅总览任务用）：dataURL，单张 ≤ 2.5MB 字符，最多 8 张
    images: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          name: z.string().max(120).optional(),
          dataUrl: z
            .string()
            .max(2_621_440)
            .refine((s) => /^data:image\/(jpeg|png|webp);base64,/.test(s), {
              message: "仅支持 jpeg/png/webp dataURL",
            }),
        }),
      )
      .max(8)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.messages.reduce((n, m) => n + Array.from(m.text).length, 0) >
      MAX_TEXT_CHARS
    )
      ctx.addIssue({ code: "custom", message: "聊天过长，请缩小范围" });
    if (new Set(v.messages.map((m) => m.id)).size !== v.messages.length)
      ctx.addIssue({ code: "custom", message: "重复消息ID" });
    if (v.targetIds.some((id) => !v.messages.some((m) => m.id === id)))
      ctx.addIssue({ code: "custom", message: "目标消息不存在" });
    if (
      v.task === "self_message" &&
      (!v.targetIds.length ||
        v.targetIds.some(
          (id) => v.messages.find((m) => m.id === id)?.sender !== "self",
        ))
    )
      ctx.addIssue({ code: "custom", message: "我方目标无效" });
    if (
      v.task === "other_messages" &&
      (!v.targetIds.length ||
        v.targetIds.some(
          (id) => v.messages.find((m) => m.id === id)?.sender !== "other",
        ))
    )
      ctx.addIssue({ code: "custom", message: "对方目标无效" });
  });

const app = express();
app.disable("x-powered-by");
// 反代后置：信任 Nginx 转发的 X-Forwarded-Proto/For，让 req.protocol 正确解析 https，
// 否则 Origin 校验会把 https://dalang... 误判为 http://dalang... 导致 403。
app.set("trust proxy", true);
// 捕获原始 body 字节供微信支付回调验签（验签必须用原始文本，顺序敏感）。
app.use(
  express.json({
    limit: "32mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (_req, res) => {
  const c = loadConfig();
  res.json({
    mode: LOCAL_MODE ? "local" : "saas",
    configured: Boolean(c.relay.apiKey),
    model: c.relay.model,
    engine: "dalang-relay",
    vector: {
      mode: vectorService.mode,
      hasKey: Boolean(c.embedding.apiKey),
      baseUrl: c.embedding.provider === "cloud" ? c.embedding.baseUrl : null,
      last: vectorService.lastCloudInfo,
      cache: { hits: vectorService.cacheHits, misses: vectorService.cacheMisses },
    },
    profiles: profile.listProfiles().roster.length,
  });
});

// ---------- 鉴权 + 积分（多用户 SaaS） ----------
/**
 * 用量累加器：在一次请求内多次 chatCompletion 调用时汇总 TokenUsage。
 * 路由调用前后分别做「调用前余额校验」和「调用后按实际 usage 扣费」。
 */
function makeUsageSink() {
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0 };
  const jevUsage: Usage = { input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0 };
  return {
    usage,
    jevUsage,
    add: (u: TokenUsage) => {
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.cache_hit_tokens =
        (usage.cache_hit_tokens ?? 0) + (u.cache_hit_tokens ?? 0);
    },
    addJev: (u: TokenUsage) => {
      jevUsage.input_tokens += u.input_tokens;
      jevUsage.output_tokens += u.output_tokens;
      jevUsage.cache_hit_tokens =
        (jevUsage.cache_hit_tokens ?? 0) + (u.cache_hit_tokens ?? 0);
    },
  };
}

/** 调用前校验：估算本次用量折算积分，余额不足直接 402（避免白烧上游配额）。
 *  estText 往往是 JSON.stringify(请求体)，含图片 base64——必须剔除，
 *  否则估算被 base64 撑爆，余额充足也会误报「积分不足」（2026-09-25 实测 bug）。 */
function precheckCredits(userId: string, estText: string, imageCount = 0): boolean {
  const clean = estText.replace(
    /data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/g,
    "",
  );
  const est = estimateUsage(clean, imageCount);
  return getBalance(userId) >= estimateCost(est);
}

app.post("/api/auth/register", (req, res) => {
  const { email, password } = req.body ?? {};
  try {
    const r = registerUser(String(email ?? ""), String(password ?? ""));
    res.json(r);
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};
  try {
    const r = loginUser(String(email ?? ""), String(password ?? ""));
    res.json(r);
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/credits/balance", authMiddleware, (req, res) => {
  res.json({
    credits: getBalance(req.userId as string),
    pricing: {
      inputPerK: INPUT_PER_K,
      cachePerK: CACHE_PER_K,
      outputPerK: OUTPUT_PER_K,
    },
  });
});

// ---------- 充值（微信支付 Native 扫码） ----------
// 套餐列表（1 元 = 100 分）
app.get("/api/recharge/packages", authMiddleware, (_req, res) => {
  res.json({ packages: RECHARGE_PACKAGES });
});

// 下单：本地建单 + 微信 Native 下单，返回 codeUrl 供前端渲染二维码
app.post("/api/recharge/create", authMiddleware, async (req, res) => {
  const packageId = String((req.body ?? {}).packageId ?? "");
  const pkg = getPackage(packageId);
  if (!pkg) {
    res.status(400).json({ error: "套餐不存在" });
    return;
  }
  try {
    const order = createOrder(req.userId as string, pkg.id);
    const outTradeNo = `${order.orderId}-${Date.now().toString(36)}`;
    const r = await createNativeOrder({
      outTradeNo,
      description: `恋爱之神·积分充值 ${pkg.name}`,
      amountFen: Math.round(pkg.priceYuan * 100),
    });
    if (r.error) {
      res.status(503).json({ error: r.error });
      return;
    }
    res.json({ orderId: order.orderId, codeUrl: r.codeUrl, package: pkg });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 我的充值订单
app.get("/api/recharge/orders", authMiddleware, (req, res) => {
  res.json({ orders: listOrders(req.userId as string) });
});

// ---------- 向量库订阅（6.6 元/月，独立于积分计费；积分只算 GPT 模型费用） ----------
// 套餐列表（1/3/6/12 月，越多折扣越多）
app.get("/api/vector/packages", authMiddleware, (_req, res) => {
  res.json({ packages: VECTOR_PACKAGES });
});

// 我的向量库状态（含 key 明文，用户点「获取 key」后可见；keyMask 用于脱敏展示）
app.get("/api/vector/status", authMiddleware, (req, res) => {
  res.json(getVectorStatus(req.userId as string));
});

// 签发/轮换每用户向量库调用 key（返回明文，只返回这一次，请用户保存）
app.post("/api/vector/key", authMiddleware, (req, res) => {
  try {
    const key = issueVectorKey(req.userId as string);
    res.json({ ...getVectorStatus(req.userId as string), key });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 订阅下单：本地建单（kind=vector）+ 微信 Native 下单，返回 codeUrl
app.post("/api/vector/subscribe", authMiddleware, async (req, res) => {
  const packageId = String((req.body ?? {}).packageId ?? "");
  const pkg = getVectorPackage(packageId);
  if (!pkg) {
    res.status(400).json({ error: "套餐不存在" });
    return;
  }
  try {
    const order = createVectorOrder(req.userId as string, pkg.id);
    const outTradeNo = `${order.orderId}-${Date.now().toString(36)}`;
    const r = await createNativeOrder({
      outTradeNo,
      description: `恋爱之神·向量库订阅 ${pkg.name}`,
      amountFen: Math.round(pkg.priceYuan * 100),
    });
    if (r.error) {
      res.status(503).json({ error: r.error });
      return;
    }
    res.json({ orderId: order.orderId, codeUrl: r.codeUrl, package: pkg });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 向量库调用端点（key 鉴权，只开放调用权限）：用户拿 dlv_ key 直接检索大浪库。
// 该端点不走 JWT / 不需要登录，拿 key 只能检索、碰不到积分/档案/后台。
app.post("/api/vector/retrieve", async (req, res) => {
  const key =
    String(req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "")
      .trim() || String(req.headers["x-api-key"] || "").trim();
  const user = key ? findUserByVectorKey(key) : undefined;
  if (!user || !hasVectorAccess(user)) {
    res.status(401).json({ error: "无效的向量库 key，或已过期 / 已被关闭" });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const situation = String(b.situation ?? "").slice(0, 600);
  const girlProfile = String(b.girl_profile ?? b.girlProfile ?? "").slice(0, 1500);
  const chatLog = String(b.chat_log ?? b.chatLog ?? "").slice(0, 8000);
  const userProfile = String(b.user_profile ?? b.userProfile ?? "").slice(0, 1500);
  if (!situation && !girlProfile && !chatLog && !userProfile) {
    res.status(400).json({
      error: "缺少检索输入（situation / girl_profile / chat_log / user_profile 至少一项）",
    });
    return;
  }
  const topK = Math.min(8, Math.max(1, Number(b.top_k ?? b.topK ?? 5) || 5));
  try {
    const r = await vectorService.search(
      {
        query: [situation, girlProfile, chatLog, userProfile]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1200),
        situation,
        chatLog,
        girlProfile,
        userProfile,
      },
      topK,
    );
    res.json({
      cases: r.cases,
      rules: r.rules,
      strategies: r.strategies,
      templates: r.templates,
    });
  } catch (e) {
    res.status(502).json({ error: `向量库检索失败：${(e as Error).message}` });
  }
});

// 微信异步回调（无鉴权）：验签 + 解密 + 幂等入账。返回纯文本 "success"/"fail"。
app.post("/api/pay/wechat/notify", async (req, res) => {
  const rawBody =
    (req as unknown as { rawBody?: Buffer }).rawBody?.toString() ??
    JSON.stringify(req.body ?? {});
  const timestamp = String(req.headers["wechatpay-timestamp"] || "");
  const nonce = String(req.headers["wechatpay-nonce"] || "");
  const serial = String(req.headers["wechatpay-serial"] || "");
  const signature = String(req.headers["wechatpay-signature"] || "");

  const result = await verifyAndDecrypt(rawBody, {
    timestamp,
    nonce,
    serial,
    signature,
  });
  if (!result.ok) {
    console.error("[微信回调] 验签/解密失败:", result.error);
    res.status(400).send("fail");
    return;
  }

  const d = result.decrypted;
  if (d.trade_state === "SUCCESS" || d.trade_state === "FINISHED") {
    const outTradeNo = String(d.out_trade_no || "");
    const orderId = outTradeNo.includes("-") ? outTradeNo.split("-")[0] : outTradeNo;
    const totalYuan = Number(d.amount?.total ?? 0) / 100;
    const order = getOrder(orderId);
    if (order && order.status === "pending_payment") {
      if (totalYuan > 0 && Math.abs(totalYuan - order.priceYuan) > 0.001) {
        console.error(
          `[微信回调] 金额不符 ${orderId}: 期望 ¥${order.priceYuan}, 实际 ¥${totalYuan}`,
        );
        res.status(400).send("fail");
        return;
      }
      const r = settleOrder(orderId, String(d.transaction_id || outTradeNo));
      console.log(
        `[微信回调] 充值单 ${orderId} ${r.ok ? `到账 ${r.balance}` : r.error}`,
      );
    } else {
      console.log(
        `[微信回调] 订单 ${orderId} ${order ? `状态=${order.status}` : "不存在"}，跳过`,
      );
    }
  }
  res.send("success");
});

// ---------- 分析 ----------
let calls = 0;
let windowAt = Date.now();
let active = 0;
const budgets = new Map<string, { count: number; at: number }>();
app.post("/api/analyze", authMiddleware, async (req, res) => {
  const origin = req.headers.origin;
  if (
    origin &&
    origin !== `${req.protocol}://${req.headers.host}` &&
    !["http://127.0.0.1:5178", "http://localhost:5178"].includes(origin)
  ) {
    res.status(403).json({ error: "请求来源不允许" });
    return;
  }
  const valid = requestSchema.safeParse(req.body);
  if (!valid.success) {
    // 把 Zod 具体报错落到服务端日志，前端只给友好提示（避免下次再靠猜）
    console.error(
      "[analyze] schema 校验失败:",
      JSON.stringify(valid.error.issues.slice(0, 5)),
    );
    res.status(400).json({ error: "聊天结构或长度不符合要求，请校正后重试" });
    return;
  }
  if (!loadConfig().relay.apiKey) {
    res
      .status(503)
      .json({ error: "尚未配置中转站 API Key，请在「模型设置」里填写后重试" });
    return;
  }
  // 🔴 付费漏斗第一层（2026-09-27 用户定板）：向量库订阅是分析的硬前提——
  // 不订阅不允许分析，订阅之后才是积分充值（第二层）。云端检索失败仍硬门。
  if (!hasVectorAccess(getUserById(req.userId as string))) {
    res.status(403).json({
      error: "请先订阅向量库（6.6元/月）再使用分析：点右上角「向量库订阅」开通，大浪实战库命中是分析的核心依据。",
    });
    return;
  }
  // 调用前校验余额（估算本次用量折算积分），不足直接 402
  if (!precheckCredits(req.userId as string, JSON.stringify(valid.data), valid.data.images?.length ?? 0)) {
    res.status(402).json({ error: "积分不足" });
    return;
  }
  // 🔴 铁律（2026-09-27 用户要求）：「下一步」动作/好感度/下一句由总览任务产出，
  // 必须结合资料卡全面分析——缺卡直接拒绝，禁止不看资料就下结论。
  if (valid.data.task === "overview" && !valid.data.profileId) {
    res.status(400).json({
      error: "请先给当前窗口绑定她的资料卡，再生成「下一步」（导入聊天时会自动建档，或右上角「绑定资料卡」）。",
    });
    return;
  }
  const now = Date.now();
  if (now - windowAt > 3600000) {
    calls = 0;
    windowAt = now;
    budgets.clear();
  }
  const key = req.ip || "local";
  let entry = budgets.get(key);
  if (!entry || now - entry.at > 60000) {
    entry = { count: 0, at: now };
    budgets.set(key, entry);
  }
  if (entry.count >= 180 || calls >= 3000 || active >= 8) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((entry.at + 60000 - now) / 1000))),
    );
    res.status(429).json({ error: "分析请求较多，已保留进度，请稍后继续" });
    return;
  }
  entry.count++;
  calls++;
  active++;
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const sink = makeUsageSink();
    const result = await analyze(
      valid.data,
      controller.signal,
      req.userId,
      sink.add,
      sink.addJev,
    );
    // 🔴 双桶计费（2026-10-01）：overview 现在「Jev 判好感度 + GPT 出下一步」两段都计费，
    // Jev 桶走 Jev 单价（输出免费、ceil≥1分），GPT 桶走 GPT 单价；逐条纯 Jev 只走 Jev 桶。
    let credits = getBalance(req.userId as string);
    let cost = 0;
    if (sink.jevUsage.input_tokens > 0 || sink.jevUsage.output_tokens > 0) {
      const r = deductJevCredits(req.userId as string, sink.jevUsage);
      credits = r.credits;
      cost += r.cost;
    }
    if (sink.usage.input_tokens > 0 || sink.usage.output_tokens > 0) {
      const r = deductCredits(req.userId as string, sink.usage);
      credits = r.credits;
      cost += r.cost;
    }
    // 扣费审计日志（2026-10-01 主人要求「一定要产生扣款」可查证）：
    // 每笔分析实际扣了多少分、多少 token，pm2 logs 里 [bill] 一查便知。
    console.log(
      `[bill] user=${req.userId} model=${result.model} gpt_in=${sink.usage.input_tokens} gpt_cached=${sink.usage.cache_hit_tokens ?? 0} gpt_out=${sink.usage.output_tokens} jev_in=${sink.jevUsage.input_tokens} jev_out=${sink.jevUsage.output_tokens} cost=${cost}分`,
    );
    res.json({ ...result, credits });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      res.status(402).json({ error: "积分不足" });
      return;
    }
    const status = Number((error as { status?: number }).status) || 502;
    if (!res.headersSent && !controller.signal.aborted)
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: (error as Error).message || "分析未完成，可能是网络超时。已保留聊天，可重试。",
      });
  } finally {
    active--;
  }
});

// ---------- 资料卡匹配（聊天名字 → 库内档案） ----------
app.get("/api/profile/match", authMiddleware, (req, res) => {
  const name = String(req.query.name ?? "").slice(0, 80);
  if (!name.trim()) {
    res.status(400).json({ error: "缺少名字" });
    return;
  }
  const id = profile.matchProfile(name, req.userId);
  res.json({ matched: Boolean(id), id, name });
});

// ---------- agent 对话（大浪 PLUS：云端库 + 资料卡 + 当前聊天综合分析） ----------
const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(30),
  profileId: z.string().max(80).optional(),
  chatLog: z.string().max(12000).optional(),
  relation: z.enum(["crush", "new", "couple"]).optional(),
  /** 聊天记录已由结构化分析线（六维/情绪/意图）产出结论，直接引用，不重复分析 */
  analysisSummary: z.string().max(2000).optional(),
  /** 流式传输：true 时返回 SSE 逐字推送到前端，边收边显示 */
  stream: z.boolean().optional(),
});

app.post("/api/chat", authMiddleware, async (req, res) => {
  const origin = req.headers.origin;
  if (
    origin &&
    origin !== `${req.protocol}://${req.headers.host}` &&
    !["http://127.0.0.1:5178", "http://localhost:5178"].includes(origin)
  ) {
    res.status(403).json({ error: "请求来源不允许" });
    return;
  }
  const valid = chatSchema.safeParse(req.body);
  if (!valid.success) {
    res.status(400).json({ error: "对话内容不符合要求" });
    return;
  }
  if (!loadConfig().relay.apiKey) {
    res
      .status(503)
      .json({ error: "尚未配置中转站 API Key，请在「模型设置」里填写后重试" });
    return;
  }
  // 🔴 付费漏斗第一层（2026-09-27 用户定板）：大浪指导同样必须先订阅向量库——
  // 未订阅直接 403 引导订阅，订阅之后才是积分充值（第二层）。
  if (!hasVectorAccess(getUserById(req.userId as string))) {
    res.status(403).json({
      error: "请先订阅向量库（6.6元/月）再问大浪指导：点右上角「向量库订阅」开通，云端实战库命中是指导的核心依据。",
    });
    return;
  }
  // 调用前校验余额
  if (!precheckCredits(req.userId as string, JSON.stringify(valid.data))) {
    res.status(402).json({ error: "积分不足" });
    return;
  }
  const { messages, profileId, chatLog, relation, analysisSummary, stream } =
    valid.data;
  // 🔴 铁律（2026-09-27 用户要求）：大浪指导必须基于「资料卡 + 聊天记录」全面分析，
  // 缺任何一项直接拒绝，禁止不看资料、不看聊天就凭模型瞎答（记忆错乱/编造的源头）。
  if (!profileId) {
    res.status(400).json({
      error: "请先给当前窗口绑定她的资料卡，再问大浪指导（右上角「绑定资料卡」）。",
    });
    return;
  }
  if (!chatLog || !chatLog.trim()) {
    res.status(400).json({
      error: "当前窗口还没有聊天记录，先粘贴聊天（Ctrl+Enter 导入）再问大浪指导。",
    });
    return;
  }
  const prof = profile.profileSummary(profileId, req.userId);
  if (profileId && !prof) {
    res.status(404).json({ error: "资料卡不存在" });
    return;
  }
  // 云端检索：当前对话场景 → 大浪库命中
  // 2026-09-24 修复配额打满：原来每条消息 1 次检索（问 5 个问题烧 5 次配额）。
  // 现在按「聊天窗口」给稳定 cacheKey：同一窗口（profileId + 关系 + 聊天记录
  // 稳定前段）的多轮提问共享 1 次检索，30 分钟内零重复消耗。
  // 2026-09-25 订阅门槛：向量库是独立订阅（6.6元/月）。
  // 2026-09-27 升级为硬门：未订阅在上方直接 403 拒绝，能走到这里的必然已订阅，
  // 必然走向量检索（检索失败仍硬门 502），不再有"纯模型降级"路径。
  const vectorAllowed = hasVectorAccess(getUserById(req.userId as string));
  let retrievedBlock = "";
  if (vectorAllowed) {
    try {
      const last = messages[messages.length - 1].content;
      const windowKey = createHash("sha256")
        .update(
          JSON.stringify([
            "chat",
            profileId ?? "",
            relation ?? "",
            (chatLog ?? "").slice(0, 1500),
          ]),
        )
        .digest("hex");
      const r = await vectorService.search(
        {
          query: last.slice(0, 600),
          situation: `恋爱推进对话分析｜${relation ? ["暧昧中", "刚认识", "恋爱中"][["crush", "new", "couple"].indexOf(relation)] : "未知关系"}`,
          chatLog: (chatLog ?? "").slice(-4000),
          girlProfile: (prof ?? "").slice(0, 1500),
          userProfile: "",
          cacheKey: windowKey,
        },
        5,
      );
      const all = [...r.rules, ...r.strategies, ...r.cases, ...r.templates] as {
        id?: unknown;
        score?: unknown;
        text?: unknown;
      }[];
      if (all.length)
        retrievedBlock = all
          .slice(0, 5)
          .map((x) => `- [${x.id}]（相似度 ${x.score ?? "?"}）${String(x.text ?? "").slice(0, 400)}`)
          .join("\n");
    } catch (e) {
      res.status(502).json({
        error: `云端向量库检索失败：${(e as Error).message}`,
      });
      return;
    }
  }
  const system = [
    "你是「恋爱之神大浪」推进教练 agent，给用户做恋爱推进的对话式分析与建议。",
    (() => {
      const n = new Date();
      const pad = (x: number) => String(x).padStart(2, "0");
      const hhmm = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
      const week = ["日", "一", "二", "三", "四", "五", "六"][n.getDay()];
      const night =
        n.getHours() >= 21 || n.getHours() < 2;
      return `# 当前时间：${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} ${hhmm}（周${week}${night ? "，夜间推进窗口 21:30-02:00：禁止劝睡收线，只许用下次钩子收" : ""}）。判读回复间隔必须用消息时间戳与当前时间的差值。`;
    })(),
    "规则优先级：① 大浪实战库命中 > ② 她的资料卡 > ③ 通用判断。引用命中编号（如 case_080）说明依据。",
    "回复风格：直接给结论和动作，短句拆条（单条≤10字，两个空格分段），不写小作文，不情绪指控，不劝睡收线。",
    "夜间窗口（21:30-02:00）禁止劝睡收线，只许用下次钩子收。",
    "识别到捞女/拜金/资源索取信号直接点明风险并给止损条件。",
    retrievedBlock ? `# 向量库检索结果（优先采纳）\n${retrievedBlock}` : "",
    vectorAllowed
      ? ""
      : "# 说明：当前用户未订阅向量库，本轮没有大浪实战库命中，按通用判断输出，禁止编造命中编号（case_xxx 等）。",
    prof ? `# 她的资料卡（综合分析必须结合档案）\n${prof}` : "",
    chatLog ? `# 当前聊天记录（最近部分，仅供对照原文，不要重新逐句分析）\n${chatLog.slice(-3000)}` : "",
    analysisSummary
      ? `# 聊天结构化分析结论（聊天记录已被分析引擎分析过，直接引用这些结论，不要重复分析）\n${analysisSummary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  // SSE 帧写出：data: <json>\n\n，前端逐帧 JSON.parse 累加 delta
  const writeSSE = (obj: unknown) =>
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chatMessages: ChatMessage[] = [
    { role: "system", content: system },
    ...messages.slice(-16).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];
  if (stream) {
    // 流式：先落 SSE 头，再逐 token 推给前端（边收边显示，根治长输出等待）
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    let streamedAny = false;
    try {
      const { content, usage } = await chatCompletion(chatMessages, {
        signal: controller.signal,
        timeoutMs: 300000,
        onToken: (delta) => {
          streamedAny = true;
          writeSSE({ delta });
        },
      });
      // 上游非流式兜底：onToken 没触发过，整段一次性补发
      if (!streamedAny && content) writeSSE({ delta: content });
      // 扣费（与一次性 JSON 路径一致），credits 随结束帧带给前端
      let credits: number | undefined;
      try {
        ({ credits } = deductCredits(req.userId as string, usage));
      } catch {
        /* 扣费失败不阻塞流式结果 */
      }
      writeSSE({ done: true, credits, vectorActive: vectorAllowed });
      res.end();
    } catch (error) {
      const status = Number((error as { status?: number }).status) || 502;
      if (!controller.signal.aborted)
        writeSSE({
          error:
            (error as Error).message ||
            (status >= 400 && status < 600 ? "对话失败，请重试" : "对话失败，请重试"),
        });
      res.end();
    }
    return;
  }
  try {
    const { content, usage } = await chatCompletion(chatMessages, {
      signal: controller.signal,
      timeoutMs: 120000,
    });
    const { credits } = deductCredits(req.userId as string, usage);
    res.json({ reply: content, credits, vectorActive: vectorAllowed });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      res.status(402).json({ error: "积分不足" });
      return;
    }
    const status = Number((error as { status?: number }).status) || 502;
    if (!res.headersSent && !controller.signal.aborted)
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: (error as Error).message || "对话失败，请重试" });
  }
});

// ---------- 视觉提取（资料建档 + 聊天截图 OCR） ----------
const visionSchema = z.object({
  images: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        name: z.string().max(120).optional(),
        dataUrl: z
          .string()
          .max(2_621_440)
          .refine((s) => /^data:image\/(jpeg|png|webp);base64,/.test(s), {
            message: "仅支持 jpeg/png/webp dataURL",
          }),
      }),
    )
    .min(1), // 张数不限（2026-09-24）：资料建档分批识别；物理上限由 express.json 32mb 约束
  platform: z.string().max(20).optional(),
});

/** vision 路由公共前置：来源检查 + 结构校验 + key 检查。校验失败已响应，返回 null。 */
async function visionPrecheck(
  req: express.Request,
  res: express.Response,
): Promise<{ images: { id: string; name?: string; dataUrl: string }[]; platform?: string } | null> {
  const origin = req.headers.origin;
  if (
    origin &&
    origin !== `${req.protocol}://${req.headers.host}` &&
    !["http://127.0.0.1:5178", "http://localhost:5178"].includes(origin)
  ) {
    res.status(403).json({ error: "请求来源不允许" });
    return null;
  }
  const valid = visionSchema.safeParse(req.body);
  if (!valid.success) {
    res.status(400).json({ error: "图片不符合要求（仅 jpeg/png/webp，单张 ≤2.5MB）" });
    return null;
  }
  if (!loadConfig().relay.apiKey) {
    res
      .status(503)
      .json({ error: "尚未配置中转站 API Key，请在「模型设置」里填写后重试" });
    return null;
  }
  return valid.data;
}

// 资料截图 → 结构化档案（AI 读抖音/探探/牵手等资料页，前端确认后落库）
app.post("/api/vision/profile-extract", authMiddleware, async (req, res) => {
  const data = await visionPrecheck(req, res);
  if (!data) return;
  // 调用前校验余额（图片按每张固定估算）
  if (!precheckCredits(req.userId as string, JSON.stringify(data), data.images.length)) {
    res.status(402).json({ error: "积分不足" });
    return;
  }
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const sink = makeUsageSink();
    // 🔴 身份说明（2026-10-01）：公域名 ≠ 微信名时的对照说明，随图传给模型防更错卡
    const note =
      typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : "";
    const result = await extractProfile(data.images, data.platform, sink.add, note);
    // 第二阶段：深层综合分析（主模型 + 向量库方法论命中；云端检索失败会抛错 = 硬门）
    result.deep = await synthesizeDeep(result, sink.add);
    const { credits } = deductCredits(req.userId as string, sink.usage);
    res.json({ ...result, credits });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      res.status(402).json({ error: "积分不足" });
      return;
    }
    // 🔴 必须落日志（2026-09-25 事故：识别失败但 error log 全空，排障只能靠盲猜）
    console.error(
      "[profile-extract] 识别失败",
      new Date().toISOString(),
      (error as Error)?.stack || (error as Error)?.message || error,
    );
    const status = Number((error as { status?: number }).status) || 502;
    if (!res.headersSent && !controller.signal.aborted)
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: (error as Error).message || "资料识别失败，请重试" });
  }
});

// 聊天截图 → 对话行（逐字转录 + 气泡侧别标注，谁是谁由用户确认）
app.post("/api/vision/chat-ocr", authMiddleware, async (req, res) => {
  const data = await visionPrecheck(req, res);
  if (!data) return;
  // OCR 必须整屏连续转录（跨屏衔接去重），不能像资料提取那样分批，保留上限
  if (data.images.length > 12) {
    res
      .status(400)
      .json({ error: "聊天截图一次最多 12 张，多了请分两批转（聊天页加图按钮本身限 8 张）" });
    return;
  }
  // 调用前校验余额
  if (!precheckCredits(req.userId as string, JSON.stringify(data), data.images.length)) {
    res.status(402).json({ error: "积分不足" });
    return;
  }
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const sink = makeUsageSink();
    const result = await ocrChat(data.images, sink.add);
    const { credits } = deductCredits(req.userId as string, sink.usage);
    res.json({ ...result, credits });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      res.status(402).json({ error: "积分不足" });
      return;
    }
    const status = Number((error as { status?: number }).status) || 502;
    if (!res.headersSent && !controller.signal.aborted)
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: (error as Error).message || "截图识别失败，请重试" });
  }
});

// 公域开场白：基于已提取的资料 + 通道类型，生成开场白 + 反应分支（§5 开场分流）
app.post("/api/vision/opener", authMiddleware, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const channel = body.channel === "cold" ? "cold" : "matched";
  const rawProfile = (body.profile ?? {}) as Record<string, unknown>;
  // 从 profile 提取 generateOpener 需要的最小子集，其余字段补默认值
  const profile = {
    platform: typeof rawProfile.platform === "string" ? rawProfile.platform : "",
    nickname: typeof rawProfile.nickname === "string" ? rawProfile.nickname : "",
    age: typeof rawProfile.age === "string" ? rawProfile.age : "",
    city: typeof rawProfile.city === "string" ? rawProfile.city : "",
    occupation: typeof rawProfile.occupation === "string" ? rawProfile.occupation : "",
    income: typeof rawProfile.income === "string" ? rawProfile.income : "",
    bio: typeof rawProfile.bio === "string" ? rawProfile.bio : "",
    interests: Array.isArray(rawProfile.interests)
      ? rawProfile.interests.map(String).slice(0, 20)
      : [],
    photosSummary: typeof rawProfile.photosSummary === "string" ? rawProfile.photosSummary : "",
    authenticity: typeof rawProfile.authenticity === "string" ? rawProfile.authenticity : "",
    redFlags: Array.isArray(rawProfile.redFlags) ? rawProfile.redFlags.map(String).slice(0, 20) : [],
    notes: typeof rawProfile.notes === "string" ? rawProfile.notes : "",
    facts: Array.isArray(rawProfile.facts)
      ? (rawProfile.facts as { item?: unknown; value?: unknown }[]).map((f) => ({
          item: String(f?.item ?? ""),
          value: String(f?.value ?? ""),
        }))
      : [],
    photoObservations: [],
    deep: null,
  };
  if (!profile.nickname && !profile.bio && !profile.notes && !profile.interests.length) {
    res.status(400).json({ error: "缺少资料内容：请先识别资料截图，再生成开场白" });
    return;
  }
  if (!precheckCredits(req.userId as string, JSON.stringify(profile), 0)) {
    res.status(402).json({ error: "积分不足" });
    return;
  }
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const sink = makeUsageSink();
    const result = await generateOpener(profile, channel, sink.add);
    const { credits } = deductCredits(req.userId as string, sink.usage);
    res.json({ ...result, credits });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      res.status(402).json({ error: "积分不足" });
      return;
    }
    const status = Number((error as { status?: number }).status) || 502;
    if (!res.headersSent && !controller.signal.aborted)
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: (error as Error).message || "开场白生成失败，请重试" });
  }
});

// ---------- 模型 / 向量库配置 ----------
app.get("/api/config", (_req, res) => res.json(publicConfig()));

// 单机模式「跑通」探测（2026-09-30 主人定板：引导要「配置+跑通」才隐藏）：
// ① 中转站 = GET /models 探活（不发推理请求，零 token 消耗）；
// ② 向量库 = license 强制换 token（exchange 不计入检索配额）。
// 仅 local 模式开放（SaaS 的 key 由服务端注入，用户侧无需测试）。
app.get("/api/config/test", async (_req, res) => {
  if (!LOCAL_MODE) {
    res.status(403).json({ error: "仅单机模式支持连通测试" });
    return;
  }
  const c = loadConfig();
  const out: Record<string, { ok: boolean; detail: string }> = {};
  if (!c.relay.apiKey) {
    out.relay = { ok: false, detail: "未配置中转站 API Key" };
  } else {
    try {
      const r = await fetch(`${c.relay.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${c.relay.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      out.relay = r.ok
        ? { ok: true, detail: "中转站连通" }
        : { ok: false, detail: `HTTP ${r.status}（Key 无效或已过期）` };
    } catch (e) {
      out.relay = { ok: false, detail: (e as Error).message };
    }
  }
  if (c.embedding.provider === "cloud") {
    if (!c.embedding.apiKey) {
      out.embedding = { ok: false, detail: "未配置向量库 license" };
    } else {
      out.embedding = await vectorService.verifyLicense();
    }
  } else {
    out.embedding = { ok: true, detail: "本地模型，无需探测" };
  }
  out.jev = await testJev();
  res.json(out);
});

app.post("/api/config", (req, res) => {
  const body = req.body ?? {};
  const patch: Partial<AppConfig> = {};
  if (body.relay && typeof body.relay === "object") {
    const r = body.relay as Record<string, unknown>;
    patch.relay = {
      baseUrl: typeof r.baseUrl === "string" ? r.baseUrl : undefined,
      apiKey:
        typeof r.apiKey === "string" && r.apiKey.length > 0
          ? r.apiKey
          : undefined,
      model: typeof r.model === "string" ? r.model : undefined,
    } as AppConfig["relay"];
  }
  if (body.embedding && typeof body.embedding === "object") {
    const e = body.embedding as Record<string, unknown>;
    patch.embedding = {
      provider:
        e.provider === "cloud" || e.provider === "openai" || e.provider === "local"
          ? e.provider
          : undefined,
      baseUrl: typeof e.baseUrl === "string" ? e.baseUrl : undefined,
      apiKey:
        typeof e.apiKey === "string" && e.apiKey.length > 0
          ? e.apiKey
          : undefined,
      model: typeof e.model === "string" ? e.model : undefined,
    } as AppConfig["embedding"];
  }
  if (body.jev && typeof body.jev === "object") {
    const j = body.jev as Record<string, unknown>;
    patch.jev = {
      baseUrl: typeof j.baseUrl === "string" ? j.baseUrl : undefined,
      apiKey:
        typeof j.apiKey === "string" && j.apiKey.length > 0
          ? j.apiKey
          : undefined,
      model: typeof j.model === "string" ? j.model : undefined,
    } as AppConfig["jev"];
  }
  const before = loadConfig();
  const next = saveConfig(patch);
  // embedding 提供方或地址变化 → 重启检索守护进程
  if (
    JSON.stringify(before.embedding) !== JSON.stringify(next.embedding)
  ) {
    vectorService.restart();
  }
  res.json(publicConfig());
});

// ---------- 女生档案 ----------
app.get("/api/profile/list", authMiddleware, (_req, res) => {
  res.json(profile.listProfiles(_req.userId));
});

// 跨平台查重（2026-09-24）：建档前用识别出的资料字段找「可能是同一个人」的已有档案
app.post("/api/profile/dup-check", authMiddleware, (req, res) => {
  const { nickname, age, city, occupation, interests } = req.body ?? {};
  try {
    res.json({
      matches: profile.findProfileMatches(
        {
          nickname: typeof nickname === "string" ? nickname : "",
          age: typeof age === "string" ? age : "",
          city: typeof city === "string" ? city : "",
          occupation: typeof occupation === "string" ? occupation : "",
          interests: Array.isArray(interests)
            ? interests.filter((x): x is string => typeof x === "string")
            : [],
        },
        req.userId,
      ),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/profile/:id", authMiddleware, (req, res) => {
  const p = profile.getProfile(String(req.params.id), req.userId);
  if (!p) {
    res.status(404).json({ error: "档案不存在" });
    return;
  }
  res.json(p);
});

// 本地/旧版资料库一键导入（旧用户「页面+数据库」迁移到云端，免二次录入）
app.post("/api/profile/import", authMiddleware, (req, res) => {
  const body = req.body ?? {};
  const profiles = Array.isArray(body.profiles) ? body.profiles : [];
  const overwrite = body.overwrite === true;
  if (!profiles.length) {
    res.status(400).json({ error: "没有可导入的档案" });
    return;
  }
  if (profiles.length > 300) {
    res.status(400).json({ error: "一次最多导入 300 份档案" });
    return;
  }
  try {
    const r = profile.profileImportLocal(req.userId, profiles, overwrite);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 档案 id 规范（与 profile_cli.py 校验一致）：^[a-z][a-z0-9_]*_[a-z]+$（拼音_平台）。
// 2026-09-24 修复：聊天页一键建档曾生成 p+时间戳（如 pmuf2jyx8）被 CLI 拒绝 → 服务端统一兜底规范化。
const PROFILE_ID_RE = /^[a-z][a-z0-9_]*_[a-z]+$/;
const PLATFORM_SLUGS: Record<string, string> = {
  "微信": "wechat", "weixin": "wechat", "wechat": "wechat",
  "探探": "tantan", "tantan": "tantan",
  "积目": "jimu", "jimu": "jimu",
  "soul": "soul",
  "牵手": "qianshou",
  "抖音": "douyin",
  "微博": "weibo",
  "小红书": "xhs", "xhs": "xhs", "rednote": "xhs",
};

function normalizeProfileId(raw: string, platform: string): string {
  const id = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (PROFILE_ID_RE.test(id)) return id;
  // 无法挽救（含中文/非法字符/缺平台段）→ 自动生成 u+时间戳+随机段_平台
  const slug =
    PLATFORM_SLUGS[platform.trim()] ??
    PLATFORM_SLUGS[platform.trim().toLowerCase()] ??
    (/^[a-z]+$/.test(platform.trim().toLowerCase()) ? platform.trim().toLowerCase() : "other");
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}_${slug}`;
}

app.post("/api/profile/new", authMiddleware, (req, res) => {
  const { id, name, platform, verdict } = req.body ?? {};
  if (!id || !name || !platform) {
    res.status(400).json({ error: "缺少 id / name / platform" });
    return;
  }
  try {
    const finalId = normalizeProfileId(String(id), String(platform));
    const output = profile.profileNew(
      finalId,
      String(name),
      String(platform),
      String(verdict || "观察中"),
      req.userId,
    );
    res.json({ ok: true, id: finalId, output });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/profile/:id/timeline", authMiddleware, (req, res) => {
  const { t, who, text, gap } = req.body ?? {};
  if (!t || !who || !text) {
    res.status(400).json({ error: "缺少 t / who / text" });
    return;
  }
  try {
    const output = profile.profileTimelineAdd(
      String(req.params.id),
      String(t),
      String(who),
      String(text),
      String(gap || "未知"),
      req.userId,
    );
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/profile/:id/score", authMiddleware, (req, res) => {
  const body = req.body ?? {};
  const keys = ["intent", "speed", "respond", "match", "truth", "risk"];
  const scores: Record<string, number> = {};
  for (const k of keys)
    if (typeof body[k] === "number") scores[k] = body[k];
  try {
    const output = profile.profileScore(String(req.params.id), scores, req.userId);
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/profile/:id/verdict", authMiddleware, (req, res) => {
  const { verdict } = req.body ?? {};
  if (!verdict) {
    res.status(400).json({ error: "缺少 verdict" });
    return;
  }
  try {
    const output = profile.profileVerdict(String(req.params.id), String(verdict), req.userId);
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/profile/:id/patch", authMiddleware, (req, res) => {
  const patch = req.body ?? {};
  if (typeof patch !== "object" || Array.isArray(patch)) {
    res.status(400).json({ error: "补丁必须是对象" });
    return;
  }
  try {
    const output = profile.profilePatch(
      String(req.params.id),
      patch as Record<string, unknown>,
      req.userId,
    );
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ---------- 管理后台（用户/积分/订单） ----------
app.use("/api/admin", adminRouter);
app.get("/manage", (_req, res) => res.sendFile(join(__dirname, "admin.html")));

// ---------- 静态托管 ----------
const dist = join(__dirname, "../dist");
app.use(express.static(dist));
app.get("/", (_req, res) => res.sendFile(join(dist, "index.html")));

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res
      .status((err as { type?: string }).type === "entity.too.large" ? 413 : 400)
      .json({ error: "输入格式或体积不受支持" });
  },
);

const port = Number(process.env.PORT || 3178);
app.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(
    `大浪恋爱工作台 API: http://${process.env.HOST || "127.0.0.1"}:${port} · 大脑 ${loadConfig().relay.apiKey ? "已配置" : "未配置"}`,
  ),
);

// ---------- 订单卫生：未支付订单超 1 小时自动作废（2026-09-27 主人定板） ----------
// 启动清一次 + 每 5 分钟巡一次；只删 pending_payment，已入账订单永久留存。
purgeExpiredPendingOrders();
setInterval(() => {
  const n = purgeExpiredPendingOrders();
  if (n > 0) console.log(`[订单清理] 作废未支付订单 ${n} 笔（超 1 小时未付款）`);
}, 5 * 60 * 1000).unref();

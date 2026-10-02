import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  adminMiddleware,
  issueToken,
  listUsers,
  getUserById,
} from "./auth";
import { adjustCredits } from "./credits";
import { listAllOrders, getOrder, settleOrder, getPackage, getVectorPackage } from "./orders";
import {
  getVectorStatus,
  setVectorEnabled,
  setVectorExpiry,
  extendVectorExpiry,
  maskVectorKey,
} from "./vectorAccess";

/** 管理端密码：环境变量 ADMIN_PASSWORD，未配置则拒绝登录。 */
function adminPassword(): string {
  return process.env.ADMIN_PASSWORD || "";
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const ADMIN_TTL_SEC = 7 * 24 * 60 * 60; // 7 天免登录

export const adminRouter = Router();

/** 管理员登录：POST { password } → { token } */
adminRouter.post("/login", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!adminPassword()) {
    res.status(503).json({ error: "服务端未配置 ADMIN_PASSWORD" });
    return;
  }
  if (!password || !safeEqual(password, adminPassword())) {
    res.status(401).json({ error: "密码错误" });
    return;
  }
  res.json({ token: issueToken("admin", "admin", ADMIN_TTL_SEC) });
});

// 以下全部需要管理员令牌
adminRouter.use(adminMiddleware);

/** 概览统计 */
adminRouter.get("/overview", (_req, res) => {
  const users = listUsers();
  const orders = listAllOrders();
  const paid = orders.filter((o) => o.status === "credited");
  const pending = orders.filter((o) => o.status === "pending_payment");
  const revenue = paid.reduce((s, o) => s + (o.priceYuan || 0), 0);
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const t0 = today0.getTime();
  res.json({
    totalUsers: users.length,
    totalCredits: users.reduce((s, u) => s + (u.credits || 0), 0),
    totalOrders: orders.length,
    paidOrders: paid.length,
    pendingOrders: pending.length,
    pendingAmount: pending.reduce((s, o) => s + (o.priceYuan || 0), 0),
    revenue: Math.round(revenue * 100) / 100,
    todayNewUsers: users.filter((u) => (u.createdAt || 0) >= t0).length,
    todayOrders: orders.filter((o) => o.createdAt >= t0).length,
    todayRevenue: Math.round(
      paid
        .filter((o) => (o.paidAt || 0) >= t0)
        .reduce((s, o) => s + (o.priceYuan || 0), 0) * 100,
    ) / 100,
  });
});

/** 用户列表（含订单统计） */
adminRouter.get("/users", (_req, res) => {
  const users = listUsers();
  const orders = listAllOrders();
  const list = users.map((u) => {
    const uo = orders.filter((o) => o.userId === u.id);
    const paid = uo.filter((o) => o.status === "credited");
    const vs = getVectorStatus(u.id);
    return {
      id: u.id,
      email: u.email,
      credits: u.credits,
      createdAt: u.createdAt || 0,
      orderCount: uo.length,
      paidOrderCount: paid.length,
      totalPaidYuan: Math.round(paid.reduce((s, o) => s + (o.priceYuan || 0), 0) * 100) / 100,
      lastOrderAt: uo.length ? Math.max(...uo.map((o) => o.createdAt)) : 0,
      vectorEnabled: vs.enabled,
      vectorActive: vs.active,
      vectorUnlimited: vs.unlimited,
      vectorExpiresAt: vs.expiresAt,
      vectorKeyMask: vs.keyMask,
    };
  });
  res.json({ users: list });
});

/** 订单列表（含用户邮箱） */
adminRouter.get("/orders", (_req, res) => {
  const orders = listAllOrders();
  const list = orders.map((o) => {
    const u = getUserById(o.userId);
    const isVector = o.kind === "vector";
    const pkg = isVector ? getVectorPackage(o.packageId) : getPackage(o.packageId);
    return {
      orderId: o.orderId,
      email: u?.email || o.userId,
      kind: o.kind || "credits",
      packageId: o.packageId,
      packageName: pkg?.name || o.packageId,
      priceYuan: o.priceYuan,
      finalCredits: o.finalCredits,
      months: o.months || 0,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt || 0,
      paymentTransactionId: o.paymentTransactionId || "",
    };
  });
  res.json({ orders: list });
});

/** 调整积分：POST { delta }（正加负减，余额下限 0） */
adminRouter.post("/users/:id/credits", (req, res) => {
  const delta = Number(req.body?.delta);
  if (!Number.isFinite(delta)) {
    res.status(400).json({ error: "delta 必须是数字" });
    return;
  }
  const user = getUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  const balance = adjustCredits(user.id, Math.trunc(delta));
  res.json({ ok: true, email: user.email, credits: balance });
});

/**
 * 向量库调用权限管理：POST { enabled?, expiresAt?, months? }
 * - enabled: 开关（true/false）
 * - expiresAt: -1=永久、0=撤销（未订阅）、>0=指定到期时间戳
 * - months: 续费 N 个月（在当前到期日基础上叠加）
 */
adminRouter.post("/users/:id/vector", (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  const body = req.body ?? {};
  try {
    let vs = getVectorStatus(user.id);
    if (typeof body.enabled === "boolean") vs = setVectorEnabled(user.id, body.enabled);
    if (typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt))
      vs = setVectorExpiry(user.id, Math.trunc(body.expiresAt));
    if (typeof body.months === "number" && Number.isFinite(body.months) && body.months > 0)
      vs = extendVectorExpiry(user.id, body.months);
    res.json({ ok: true, email: user.email, ...vs });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 手动确认到账（微信回调未达时人工兜底）：POST {} */
adminRouter.post("/orders/:id/confirm", (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ error: "订单不存在" });
    return;
  }
  const result = settleOrder(order.orderId, `manual:${Date.now()}`);
  if (!result.ok) {
    res.status(400).json({ error: result.error || "入账失败" });
    return;
  }
  res.json({
    ok: true,
    duplicate: !!result.duplicate,
    orderId: order.orderId,
    credits: result.balance,
  });
});

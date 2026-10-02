import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { addCredits } from "./credits";
import { extendVectorExpiry } from "./vectorAccess";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORDERS_DIR = join(__dirname, "data");
const ORDERS_FILE = join(ORDERS_DIR, "orders.json");

// ---------- 充值套餐（1 元 = 100 分；大额送 bonus） ----------
export type RechargePackage = {
  id: string;
  name: string;
  priceYuan: number;
  baseCredits: number;
  bonusCredits: number;
  finalCredits: number;
};

export const RECHARGE_PACKAGES: RechargePackage[] = [
  { id: "p10", name: "10 元", priceYuan: 10, baseCredits: 1000, bonusCredits: 0, finalCredits: 1000 },
  { id: "p30", name: "30 元", priceYuan: 30, baseCredits: 3000, bonusCredits: 200, finalCredits: 3200 },
  { id: "p50", name: "50 元", priceYuan: 50, baseCredits: 5000, bonusCredits: 500, finalCredits: 5500 },
  { id: "p100", name: "100 元", priceYuan: 100, baseCredits: 10000, bonusCredits: 1500, finalCredits: 11500 },
];

export function getPackage(id: string): RechargePackage | undefined {
  return RECHARGE_PACKAGES.find((p) => p.id === id);
}

// ---------- 向量库订阅套餐（6.6 元/月；连续充越多折扣越多） ----------
export type VectorPackage = {
  id: string;
  name: string;
  months: number;
  priceYuan: number;
  discountLabel: string;
};

// 基础月费 6.6；3 月 9 折、6 月 8.8 折、12 月 8 折（越多越省）。
export const VECTOR_PACKAGES: VectorPackage[] = [
  { id: "v1", name: "1 个月", months: 1, priceYuan: 6.6, discountLabel: "" },
  { id: "v3", name: "3 个月", months: 3, priceYuan: 17.82, discountLabel: "9 折" },
  { id: "v6", name: "6 个月（半年）", months: 6, priceYuan: 34.85, discountLabel: "8.8 折" },
  { id: "v12", name: "12 个月（一年）", months: 12, priceYuan: 63.36, discountLabel: "8 折" },
];

export function getVectorPackage(id: string): VectorPackage | undefined {
  return VECTOR_PACKAGES.find((p) => p.id === id);
}

export type Order = {
  orderId: string;
  userId: string;
  packageId: string;
  priceYuan: number;
  finalCredits: number;
  status: "pending_payment" | "credited";
  paymentTransactionId?: string;
  createdAt: number;
  paidAt?: number;
  /** 订单类型：缺省 credits（积分充值）；vector = 向量库订阅 */
  kind?: "credits" | "vector";
  /** 向量库订单的月数 */
  months?: number;
};

function loadOrders(): Order[] {
  try {
    if (!existsSync(ORDERS_FILE)) return [];
    return JSON.parse(readFileSync(ORDERS_FILE, "utf-8")) as Order[];
  } catch {
    return [];
  }
}

function saveOrders(orders: Order[]): void {
  mkdirSync(ORDERS_DIR, { recursive: true });
  writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf-8");
}

/** 本地建单（pending_payment），微信 out_trade_no = orderId + "-" + base36 时间戳。 */
export function createOrder(userId: string, packageId: string): Order {
  const pkg = getPackage(packageId);
  if (!pkg) throw new Error("套餐不存在");
  const order: Order = {
    // 8 字节随机 = 16 位 hex；out_trade_no = orderId + "-" + 时间戳 ≤ 32 位（微信上限）
    orderId: randomBytes(8).toString("hex"),
    userId,
    packageId,
    priceYuan: pkg.priceYuan,
    finalCredits: pkg.finalCredits,
    status: "pending_payment",
    createdAt: Date.now(),
  };
  const orders = loadOrders();
  orders.push(order);
  saveOrders(orders);
  return order;
}

export function getOrder(orderId: string): Order | undefined {
  return loadOrders().find((o) => o.orderId === orderId);
}

/** 向量库订阅建单（kind=vector，结算时按 months 叠加订阅到期日，不碰积分）。 */
export function createVectorOrder(userId: string, packageId: string): Order {
  const pkg = getVectorPackage(packageId);
  if (!pkg) throw new Error("套餐不存在");
  const order: Order = {
    orderId: randomBytes(8).toString("hex"),
    userId,
    packageId,
    priceYuan: pkg.priceYuan,
    finalCredits: 0,
    status: "pending_payment",
    createdAt: Date.now(),
    kind: "vector",
    months: pkg.months,
  };
  const orders = loadOrders();
  orders.push(order);
  saveOrders(orders);
  return order;
}

export function listOrders(userId: string): Order[] {
  return loadOrders()
    .filter((o) => o.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 全量订单列表（管理端用，按下单时间倒序）。 */
export function listAllOrders(): Order[] {
  return loadOrders().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 🔴 未支付订单超 1 小时自动作废（2026-09-27 主人定板）：
 * pending_payment 且 createdAt 距今超过 maxAgeMs 的订单直接从 orders.json 移除。
 * 由 index.ts 启动时 + 每 5 分钟定时调用。
 * 安全性：微信回调晚到时 getOrder 查不到 → 走「订单不存在，跳过」分支，
 * 只回 success 不会误入账；已 credited 的订单永不删除（留存对账）。
 */
export function purgeExpiredPendingOrders(maxAgeMs = 3600_000): number {
  const orders = loadOrders();
  const now = Date.now();
  const kept = orders.filter(
    (o) => o.status !== "pending_payment" || now - o.createdAt <= maxAgeMs,
  );
  const removed = orders.length - kept.length;
  if (removed > 0) saveOrders(kept);
  return removed;
}

/**
 * 幂等入账：仅 pending_payment 订单可入账；重复回调返回 duplicate，余额不变。
 * 三道防线：① 状态机只接受 pending_payment；② 入账前判 status；
 * ③ 已 credited 的订单再回调直接 duplicate（不重复加积分）。
 */
export function settleOrder(
  orderId: string,
  paymentTransactionId: string,
): { ok: boolean; balance?: number; error?: string; duplicate?: boolean } {
  const orders = loadOrders();
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) return { ok: false, error: "订单不存在" };
  if (order.status === "credited") {
    return { ok: true, duplicate: true, error: "duplicate" };
  }
  // 向量库订阅订单：叠加订阅到期日（不碰积分）；积分订单：加积分。
  let balance = 0;
  if (order.kind === "vector") {
    extendVectorExpiry(order.userId, order.months ?? 1);
  } else {
    balance = addCredits(order.userId, order.finalCredits);
  }
  order.status = "credited";
  order.paymentTransactionId = paymentTransactionId;
  order.paidAt = Date.now();
  saveOrders(orders);
  return { ok: true, balance };
}

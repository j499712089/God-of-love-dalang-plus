import { randomBytes } from "node:crypto";
import { getUserById, listUsers, saveUser, type User } from "./auth";
import { LOCAL_MODE } from "./config";

/**
 * 向量库订阅与调用权限（独立于积分计费）。
 * 积分只算 GPT-5.6-SOL 的模型调用费用；向量库按「订阅」收费（6.6 元/月），
 * 每用户签发一把调用 key，只开放「调用权限」（仅 /api/vector/retrieve），
 * 管理员可随时开放/关闭。key 与 JWT 完全隔离，拿 key 拿不到积分/档案/后台。
 */

const KEY_PREFIX = "dlv_";
const MONTH_MS = 30 * 24 * 3600 * 1000;

export type VectorStatus = {
  enabled: boolean;
  subscribed: boolean;
  unlimited: boolean;
  expiresAt: number;
  active: boolean;
  key: string;
  keyMask: string;
};

export function maskVectorKey(key?: string): string {
  if (!key) return "";
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}

/** 是否具备向量库调用权限：开关开 + （永久 或 订阅未到期）。单机模式恒真（有 license 即可调云端向量库）。 */
export function hasVectorAccess(user: User | undefined): boolean {
  if (LOCAL_MODE) return true;
  if (!user) return false;
  if (user.vectorEnabled === false) return false;
  const exp = user.vectorExpiresAt ?? 0;
  if (exp === -1) return true; // 永久
  if (exp <= 0) return false; // 未订阅
  return exp > Date.now();
}

export function getVectorStatus(userId: string): VectorStatus {
  const u = getUserById(userId);
  const expiresAt = u?.vectorExpiresAt ?? 0;
  return {
    enabled: u?.vectorEnabled !== false,
    subscribed: expiresAt !== 0,
    unlimited: expiresAt === -1,
    expiresAt,
    active: hasVectorAccess(u),
    key: u?.vectorKey ?? "",
    keyMask: maskVectorKey(u?.vectorKey),
  };
}

/** 签发/轮换每用户向量库调用 key，返回明文 key（只返回一次，请用户保存）。 */
export function issueVectorKey(userId: string): string {
  const u = getUserById(userId);
  if (!u) throw new Error("用户不存在");
  const key = KEY_PREFIX + randomBytes(24).toString("hex");
  u.vectorKey = key;
  saveUser(u);
  return key;
}

/** 按 key 反查用户（供 /api/vector/retrieve 免 JWT 鉴权）。 */
export function findUserByVectorKey(key: string): User | undefined {
  const k = String(key ?? "").trim();
  if (!k) return undefined;
  return listUsers().find((u) => u.vectorKey && u.vectorKey === k);
}

/** 管理员开关向量库调用权限。 */
export function setVectorEnabled(userId: string, enabled: boolean): VectorStatus {
  const u = getUserById(userId);
  if (!u) throw new Error("用户不存在");
  u.vectorEnabled = enabled;
  saveUser(u);
  return getVectorStatus(userId);
}

/**
 * 续费：在当前到期日基础上叠加 months 个月（未订阅则从现在起算）。
 * 连续充值「越多折扣越多」体现在套餐单价上，叠加逻辑保证连续订阅不断档。
 */
export function extendVectorExpiry(userId: string, months: number): VectorStatus {
  const u = getUserById(userId);
  if (!u) throw new Error("用户不存在");
  const now = Date.now();
  const cur = u.vectorExpiresAt ?? 0;
  if (cur === -1) return getVectorStatus(userId); // 已是永久权限，续费保持不变
  const base = cur > now ? cur : now;
  u.vectorExpiresAt = base + Math.max(1, Math.floor(months)) * MONTH_MS;
  saveUser(u);
  return getVectorStatus(userId);
}

/** 管理员直接设置到期时间：-1=永久、0=未订阅（撤销）、>0=指定到期时间戳。 */
export function setVectorExpiry(userId: string, expiresAt: number): VectorStatus {
  const u = getUserById(userId);
  if (!u) throw new Error("用户不存在");
  u.vectorExpiresAt = expiresAt;
  saveUser(u);
  return getVectorStatus(userId);
}

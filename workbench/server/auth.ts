import {
  scryptSync,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response, NextFunction } from "express";
import { LOCAL_MODE } from "./config";

// 在 Express.Request 上挂载 userId（鉴权中间件写入）。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const USERS_DIR = join(__dirname, "data");
const USERS_FILE = join(USERS_DIR, "users.json");

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  salt: string;
  /** 积分账户余额（默认新用户 500） */
  credits: number;
  /** 注册时间戳（ms）；旧数据可能缺失，读取处需兜底 0 */
  createdAt: number;
  /** 向量库调用权限开关（管理员可关闭；缺省视为 true） */
  vectorEnabled?: boolean;
  /**
   * 向量库订阅到期时间戳（ms）：
   * 缺省 / 0 = 未订阅（无调用权限）；-1 = 永久权限（管理员授予）；>0 = 到期时间。
   */
  vectorExpiresAt?: number;
  /** 每用户向量库调用 key（dlv_ 前缀，仅用于 /api/vector/retrieve 调用权限） */
  vectorKey?: string;
};

// ---------- 用户持久化（JSON 文件） ----------
function loadUsers(): User[] {
  try {
    if (!existsSync(USERS_FILE)) return [];
    return JSON.parse(readFileSync(USERS_FILE, "utf-8")) as User[];
  } catch {
    return [];
  }
}

function saveUsers(users: User[]): void {
  mkdirSync(USERS_DIR, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
}

export function getUserById(id: string): User | undefined {
  return loadUsers().find((u) => u.id === id);
}

export function getUserByEmail(email: string): User | undefined {
  const e = email.trim().toLowerCase();
  return loadUsers().find((u) => u.email.toLowerCase() === e);
}

/** 全量用户列表（管理端用，按注册时间倒序）。 */
export function listUsers(): User[] {
  return loadUsers().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function saveUser(user: User): void {
  const users = loadUsers();
  const i = users.findIndex((u) => u.id === user.id);
  if (i >= 0) users[i] = user;
  else users.push(user);
  saveUsers(users);
}

// ---------- 密码哈希（node:crypto scrypt） ----------
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password: string, user: User): boolean {
  const hash = hashPassword(password, user.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(user.passwordHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function createHashFor(password: string): { salt: string; passwordHash: string } {
  const salt = randomBytes(16).toString("hex");
  return { salt, passwordHash: hashPassword(password, salt) };
}

// ---------- JWT（手写 HMAC-SHA256，无第三方库） ----------
let JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET) {
  JWT_SECRET = randomBytes(32).toString("base64url");
  console.warn(
    "[auth] 环境变量 JWT_SECRET 未设置，已生成本次运行的临时密钥（进程重启后旧 token 失效）。" +
      "生产环境请设置 JWT_SECRET 以保证 token 长期有效。",
  );
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function b64urlDecode<T = unknown>(s: string): T {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf-8")) as T;
}

const TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30 天

export function issueToken(userId: string, role?: "admin", ttlSec = TOKEN_TTL_SEC): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { sub: userId, iat: now, exp: now + ttlSec };
  if (role) payload.role = role;
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac("sha256", JWT_SECRET)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${sig}`;
}

export function verifyToken(token: string): { sub: string; role?: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const signingInput = `${h}.${p}`;
  const expected = createHmac("sha256", JWT_SECRET)
    .update(signingInput)
    .digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = b64urlDecode<{ sub?: unknown; exp?: number; role?: unknown }>(p);
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return null;
    if (typeof payload.sub !== "string") return null;
    return {
      sub: payload.sub,
      role: typeof payload.role === "string" ? payload.role : undefined,
    };
  } catch {
    return null;
  }
}

// ---------- 鉴权中间件 ----------
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // 单机模式（DALANG_MODE=local）：免登录，req.userId 保持 undefined。
  // 下游 profile 函数 userId 可选，undefined 时走共享库 profile_db/data（单机库）。
  if (LOCAL_MODE) {
    next();
    return;
  }
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) {
    res.status(401).json({ error: "未授权：缺少 Bearer Token" });
    return;
  }
  const payload = verifyToken(m[1]);
  if (!payload) {
    res.status(401).json({ error: "无效或过期的令牌" });
    return;
  }
  req.userId = payload.sub;
  next();
}

// ---------- 管理端鉴权（要求 role=admin 的令牌） ----------
export function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) {
    res.status(401).json({ error: "未授权：缺少管理员令牌" });
    return;
  }
  const payload = verifyToken(m[1]);
  if (!payload || payload.role !== "admin") {
    res.status(401).json({ error: "无效或过期的管理员令牌" });
    return;
  }
  next();
}

// ---------- 注册 / 登录 ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type AuthResult = {
  token: string;
  user: { email: string; credits: number };
};

export function registerUser(email: string, password: string): AuthResult {
  if (typeof email !== "string" || !EMAIL_RE.test(email))
    throw new AuthError("邮箱格式不正确", 400);
  if (typeof password !== "string" || password.length < 6)
    throw new AuthError("密码至少 6 位", 400);
  if (getUserByEmail(email)) throw new AuthError("该邮箱已注册", 409);
  const { salt, passwordHash } = createHashFor(password);
  const user: User = {
    id: randomBytes(12).toString("hex"),
    email: email.trim().toLowerCase(),
    passwordHash,
    salt,
    credits: 500,
    // 🔴 2026-09-27 用户定板（23:20 终版）：新用户注册送 500 积分（100→1000→500）
    // + 3 天向量库试用（到期后 hasVectorAccess 变 false，分析/大浪指导被 403 引导订阅）
    vectorEnabled: true,
    vectorExpiresAt: Date.now() + 3 * 24 * 3600 * 1000,
    createdAt: Date.now(),
  };
  saveUser(user);
  return {
    token: issueToken(user.id),
    user: { email: user.email, credits: user.credits },
  };
}

export function loginUser(email: string, password: string): AuthResult {
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user))
    throw new AuthError("邮箱或密码错误", 401);
  return {
    token: issueToken(user.id),
    user: { email: user.email, credits: user.credits },
  };
}

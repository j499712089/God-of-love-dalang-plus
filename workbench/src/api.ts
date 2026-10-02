// 鉴权与统一 API 封装。
// 所有需要鉴权的请求都走 apiFetch：自动带 Authorization: Bearer <token>，
// 401（带 token 时）= 会话失效 → 通知跳转登录；402 = 积分不足 → 提示充值。
// 后端契约见任务说明，前端严禁写入任何密钥。

const TOKEN_KEY = "dalang_token";
const USER_KEY = "dalang_user";

// 单机模式（后端 DALANG_MODE=local 时返回 mode:"local"）：免登录、无积分，
// apiFetch 不触发 401 跳转（单机请求本就不带 token，后端也不会 401）。
let localMode = false;
export function setLocalMode(v: boolean): void {
  localMode = v;
}
export function isLocalMode(): boolean {
  return localMode;
}

export type AuthUser = { email: string; credits: number };

export type Pricing = {
  inputPerK: number;
  cachePerK: number;
  outputPerK: number;
};

export type BalanceResp = {
  credits: number;
  pricing: Pricing;
};

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// ---------- 会话失效（401）事件 ----------
type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(cb: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(cb);
  return () => sessionExpiredListeners.delete(cb);
}

function emitSessionExpired(): void {
  clearSession();
  sessionExpiredListeners.forEach((cb) => cb());
}

// ---------- 积分不足（402）提示事件 ----------
type CreditListener = (msg: string) => void;
const creditListeners = new Set<CreditListener>();

export function onCreditNotice(cb: CreditListener): () => void {
  creditListeners.add(cb);
  return () => creditListeners.delete(cb);
}

function emitCreditNotice(msg: string): void {
  creditListeners.forEach((cb) => cb(msg));
}

// ---------- 统一请求封装 ----------
export async function apiFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const resp = await fetch(url, { ...init, headers });

  if (resp.status === 401 && token && !localMode) {
    // 带着 token 还 401，说明会话已失效，统一跳登录页。
    // 单机模式（localMode）无 token、无会话概念，401 不触发跳转。
    emitSessionExpired();
  } else if (resp.status === 402 && !localMode) {
    // 积分不足，提示充值。
    let msg = "积分不足，请充值";
    try {
      const body = await resp.clone().json();
      if (body && typeof body.error === "string" && body.error) msg = body.error;
    } catch {
      /* 响应体非 JSON，用默认文案 */
    }
    emitCreditNotice(msg);
  }
  return resp;
}

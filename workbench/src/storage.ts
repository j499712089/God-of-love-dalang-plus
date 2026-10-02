import type { Message, Relation, LineResult, Overview } from "../shared/types";
import type { MemoryEvent } from "../shared/memory";
export type Trend = { at: string; value: number | null; count: number };
export type SavedConversation = {
  schema: 1;
  rubric: string;
  messages: Message[];
  self: string;
  other: string;
  relation: Relation;
  lines: Record<string, LineResult>;
  events: Record<string, MemoryEvent>;
  overview: Overview | null;
  trend: Trend[];
  analyzedCount: number;
  completed: boolean;
};
let connection: Promise<IDBDatabase> | undefined;
function db() {
  return (connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("crush-monitor", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("workspace");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      connection = undefined;
      reject(req.error);
    };
  }));
}
export async function loadConversation(): Promise<
  SavedConversation | undefined
> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const req = database
      .transaction("workspace")
      .objectStore("workspace")
      .get("current");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// Serial transactions ensure clearing cannot be followed by an older queued save.
let queue: Promise<void> = Promise.resolve();
export function saveConversation(value: SavedConversation | null) {
  const operation = queue
    .catch(() => {})
    .then(async () => {
      const database = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("workspace", "readwrite");
        if (value) tx.objectStore("workspace").put(value, "current");
        else tx.objectStore("workspace").delete("current");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("保存被中断"));
      });
    });
  queue = operation;
  return operation;
}

// ---------- 多对象会话（每个女生一个独立窗口，数据隔离） ----------
export type ConversationMeta = {
  id: string;
  name: string;
  relation: Relation;
  updated: number;
  /** 窗口绑定的资料卡：绑定一次永久生效，不用每次重新匹配 */
  profileId?: string;
  profileName?: string;
};
type ConversationIndex = { list: ConversationMeta[]; activeId: string | null };

// ---------- 账号隔离（2026-09-27）----------
// 同一浏览器多账号共用 IndexedDB，必须按登录邮箱分命名空间，否则换账号
// 登录会看到上一个账号的聊天窗口和绑定（用户实测踩坑）。scope 由 App 在
// 初始化时用当前登录邮箱设置；未设置前所有键落在无前缀（legacy）区。
let scope = "";
export function setStorageScope(email: string): void {
  scope = String(email || "").trim().toLowerCase();
}
function scoped(key: string): string {
  return scope ? `u.${scope}.${key}` : key;
}

function listKey() {
  return scoped("conversations");
}
function convKey(id: string) {
  return scoped(`conversation.${id}`);
}

const LEGACY_LIST_KEY = "conversations";
const LEGACY_CLAIM_FLAG = "dalang_legacy_claimed";

/** 本浏览器是否存在未隔离的旧会话数据，且还没被任何账号认领过（一次性导入入口用）。 */
export async function canClaimLegacyWorkspace(): Promise<boolean> {
  try {
    if (localStorage.getItem(LEGACY_CLAIM_FLAG) === "1") return false;
  } catch {
    /* ignore */
  }
  const idx = await txGet<ConversationIndex>(LEGACY_LIST_KEY);
  if (idx?.list?.length) return true;
  const legacy = await loadConversation();
  return Boolean(legacy?.messages?.length);
}

/** 把本浏览器遗留的旧会话数据整体并入当前账号名下（一次性；含窗口绑定）。 */
export async function claimLegacyWorkspace(): Promise<number> {
  let idx = await txGet<ConversationIndex>(LEGACY_LIST_KEY);
  if (!idx?.list?.length) {
    // 更老的单例记录（"current"）包装成第一个会话
    const legacy = await loadConversation();
    if (!legacy?.messages?.length) return 0;
    const id = `c${Date.now().toString(36)}`;
    idx = {
      list: [
        {
          id,
          name: legacy.other || "她",
          relation: legacy.relation,
          updated: Date.now(),
        },
      ],
      activeId: id,
    };
    await txPut(`conversation.${id}`, legacy);
  }
  let moved = 0;
  for (const meta of idx.list) {
    const data = await txGet<SavedConversation>(`conversation.${meta.id}`);
    if (data) {
      await txPut(scoped(`conversation.${meta.id}`), data);
      moved++;
    }
  }
  await txPut(scoped("conversations"), idx);
  try {
    localStorage.setItem(LEGACY_CLAIM_FLAG, "1");
  } catch {
    /* ignore */
  }
  return moved;
}

async function txGet<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const req = database
      .transaction("workspace")
      .objectStore("workspace")
      .get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function txPut(key: string, value: unknown) {
  const operation = queue
    .catch(() => {})
    .then(async () => {
      const database = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("workspace", "readwrite");
        tx.objectStore("workspace").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("保存被中断"));
      });
    });
  queue = operation;
  return operation;
}

/**
 * 读取当前账号的会话索引。2026-09-27 起按登录邮箱分命名空间：
 * 本账号名下没有索引就返回空，**绝不**自动认领本浏览器遗留的旧数据
 * （自动认领 = 换账号登录就能拿到别人的聊天，正是要修的串号 bug）。
 * 旧数据只能走 canClaimLegacyWorkspace / claimLegacyWorkspace 一次性手动导入。
 */
export async function loadConversationIndex(): Promise<ConversationIndex> {
  const idx = (await txGet<ConversationIndex>(listKey())) ?? null;
  if (idx) return idx;
  return { list: [], activeId: null };
}

export function saveConversationIndex(idx: ConversationIndex) {
  return txPut(listKey(), idx);
}

export function loadConversationData(
  id: string,
): Promise<SavedConversation | undefined> {
  return txGet<SavedConversation>(convKey(id));
}

export function saveConversationData(
  id: string,
  value: SavedConversation | null,
) {
  if (value) return txPut(convKey(id), value);
  const operation = queue
    .catch(() => {})
    .then(async () => {
      const database = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("workspace", "readwrite");
        tx.objectStore("workspace").delete(convKey(id));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("删除被中断"));
      });
    });
  queue = operation;
  return operation;
}

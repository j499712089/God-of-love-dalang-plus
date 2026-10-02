import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = join(__dirname, "config.json");

/**
 * 客户端兜底分析用的统一配置文件（cloud_client.js configure 写入的 license 存这里）。
 * 打通两套配置：工作台在云端向量库模式下，若本工作台 config.json 没填 embedding.apiKey，
 * 自动回退读取这里的 license，实现「客户端 configure 一次，工作台免配」。
 */
export const DALANG_CONFIG_PATH = join(homedir(), ".dalang", "config.json");

export type RelayConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 图片分析用的视觉模型（带图请求自动切换；实测中转站仅 terra 渠道支持 vision） */
  visionModel: string;
};
export type EmbeddingConfig = {
  provider: "cloud" | "local" | "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
};
/**
 * Jev（TypeSafe System One）快速判断模型配置（2026-10-01 接入）：
 * 与 GPT 分工——逐条情绪/意图/打分走 Jev（结构化、快、便宜），
 * 好感度总览/开场白/图片/深度分析仍走 GPT。
 */
export type JevConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};
export type AppConfig = {
  relay: RelayConfig;
  embedding: EmbeddingConfig;
  jev: JevConfig;
};

/**
 * 单机模式开关（2026-09-28）：
 * - `DALANG_MODE=local` → 本地单机部署版：免登录（authMiddleware 放行）、
 *   免积分/订阅（自己接中转站用自己的钱）、档案库走共享库 profile_db/data。
 * - 未设置（默认）→ SaaS 多用户版：注册登录 + 积分 + 订阅（线上 122.51.43.16）。
 * 本地 start.bat 启动时注入 DALANG_MODE=local；线上 .env 不设此变量保持 SaaS。
 */
export const LOCAL_MODE = process.env.DALANG_MODE === "local";

export const CLOUD_BASE_URL = "https://dalang.wenmingjianyuce.cn";
export const CLOUD_CORPUS_ID = "dalang-male-v1";
export const CLOUD_ADMIN_URL = "https://dalang.wenmingjianyuce.cn/admin";
/** 分析大脑的中转站地址锁定为官方中转站，任何配置来源都不可覆盖。 */
export const LOCKED_RELAY_BASE_URL = "https://api.foundfutureai.cn/v1";
/** Jev 快速判断模型也走官方中转站（2026-10-01 主人定板「接口换 chat/completions」），地址锁死不可覆盖。 */
export const LOCKED_JEV_BASE_URL = "https://api.foundfutureai.cn/v1";

/**
 * 视觉模型候选列表（按优先级）：带图请求时，当前 visionModel 一旦返回
 * 403/899 上游不可用或 404，就按此顺序逐个降级尝试，成功后自愈回写。
 * 实测（2026-09-30 带图计时）：astra 31.5s/图 > sol 56s/图；terra/luna 已下线 403 899。
 * 视觉模型默认用 astra（快近一倍），sol 作降级候选。
 */
export const VISION_MODEL_FALLBACKS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"];

export const DEFAULT_CONFIG: AppConfig = {
  relay: {
    baseUrl: "https://api.foundfutureai.cn/v1",
    apiKey: "",
    // new-api 渠道按模型名精确匹配（大小写敏感），官方分组下是小写 gpt-5.6-sol
    model: "gpt-5.6-sol",
    // 2026-09-30 带图计时实测：gpt-6-astra 31.5s/图、gpt-5.6-sol 56s/图、terra/luna 下线(403 899)。
    // 视觉模型默认用 astra（快近一倍）；候选按优先级排列，当前视觉模型 403/899/404 时自动逐个降级尝试。
    visionModel: "gpt-6-astra",
  },
  embedding: {
    provider: "cloud",
    baseUrl: CLOUD_BASE_URL,
    apiKey: "",
    model: "text-embedding-3-small",
  },
  jev: {
    baseUrl: LOCKED_JEV_BASE_URL,
    apiKey: "",
    model: "jev-latest",
  },
};

function readFileConfig(): Partial<AppConfig> {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * 读取客户端统一配置文件（~/.dalang/config.json）里的 license。
 * 只取 license 字段，不做任何写入；缺失/损坏返回空串。
 */
function readDalangLicense(): string {
  try {
    if (!existsSync(DALANG_CONFIG_PATH)) return "";
    const c = JSON.parse(readFileSync(DALANG_CONFIG_PATH, "utf-8"));
    return typeof c.license === "string" ? c.license.trim() : "";
  } catch {
    return "";
  }
}

/** 环境变量优先，其次 config.json，最后默认值。 */
export function loadConfig(): AppConfig {
  const f = readFileConfig();
  const relay = (f.relay ?? {}) as Partial<RelayConfig>;
  const embedding = (f.embedding ?? {}) as Partial<EmbeddingConfig>;
  const jev = (f.jev ?? {}) as Partial<JevConfig>;
  const embedProvider =
    (process.env.EMBED_PROVIDER as EmbeddingConfig["provider"]) ||
    embedding.provider ||
    DEFAULT_CONFIG.embedding.provider;
  // 打通两套配置：云端向量库模式下，工作台 config.json 未填 embedding key 时，
  // 自动回退到客户端统一配置文件 ~/.dalang/config.json 里的 license。
  // 这样客户端 `cloud_client.js configure` 配一次，工作台即可免配。
  const embedKey =
    process.env.EMBED_API_KEY ||
    embedding.apiKey ||
    (embedProvider === "cloud" ? readDalangLicense() : "") ||
    "";
  return {
    relay: {
      // 地址锁定官方中转站：config.json / 环境变量传入的 baseUrl 一律忽略
      baseUrl: LOCKED_RELAY_BASE_URL,
      apiKey: process.env.RELAY_API_KEY || relay.apiKey || "",
      model: process.env.RELAY_MODEL || relay.model || DEFAULT_CONFIG.relay.model,
      visionModel:
        process.env.RELAY_VISION_MODEL ||
        relay.visionModel ||
        DEFAULT_CONFIG.relay.visionModel,
    },
    embedding: {
      provider: embedProvider,
      baseUrl:
        process.env.EMBED_BASE_URL ||
        embedding.baseUrl ||
        DEFAULT_CONFIG.embedding.baseUrl,
      apiKey: embedKey,
      model: process.env.EMBED_MODEL || embedding.model || DEFAULT_CONFIG.embedding.model,
    },
    jev: {
      // 地址锁定官方中转站（chat/completions）：config.json / 环境变量传入的 baseUrl 一律忽略
      baseUrl: LOCKED_JEV_BASE_URL,
      apiKey: process.env.JEV_API_KEY || jev.apiKey || "",
      model: process.env.JEV_MODEL || jev.model || DEFAULT_CONFIG.jev.model,
    },
  };
}

/** 保存到 config.json（apiKey 落盘，满足「配置一次不再重复配置」；config.json 已 gitignore）。 */
export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  const clean = (obj: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
  };
  const next: AppConfig = {
    relay: {
      ...current.relay,
      ...(patch.relay ? clean(patch.relay as unknown as Record<string, unknown>) : {}),
      // 地址永远锁定官方中转站，落盘前强制覆盖
      baseUrl: LOCKED_RELAY_BASE_URL,
    },
    embedding: {
      ...current.embedding,
      ...(patch.embedding ? clean(patch.embedding as unknown as Record<string, unknown>) : {}),
    },
    jev: {
      ...current.jev,
      ...(patch.jev ? clean(patch.jev as unknown as Record<string, unknown>) : {}),
      // 地址永远锁定官方中转站，落盘前强制覆盖
      baseUrl: LOCKED_JEV_BASE_URL,
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function maskKey(key: string) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** 前端展示用：key 只回显掩码，不回明文。附带单机/SaaS 模式标志供前端分流。 */
export function publicConfig(): {
  mode: "local" | "saas";
  relay: { baseUrl: string; model: string; visionModel: string; hasKey: boolean; keyMask: string };
  embedding: EmbeddingConfig & { hasKey: boolean; keyMask: string };
  jev: { baseUrl: string; model: string; hasKey: boolean; keyMask: string };
} {
  const c = loadConfig();
  return {
    mode: LOCAL_MODE ? "local" : "saas",
    relay: {
      baseUrl: c.relay.baseUrl,
      model: c.relay.model,
      visionModel: c.relay.visionModel,
      hasKey: Boolean(c.relay.apiKey),
      keyMask: maskKey(c.relay.apiKey),
    },
    embedding: {
      provider: c.embedding.provider,
      baseUrl: c.embedding.baseUrl,
      model: c.embedding.model,
      apiKey: "",
      hasKey: Boolean(c.embedding.apiKey),
      keyMask: maskKey(c.embedding.apiKey),
    },
    jev: {
      baseUrl: c.jev.baseUrl,
      model: c.jev.model,
      hasKey: Boolean(c.jev.apiKey),
      keyMask: maskKey(c.jev.apiKey),
    },
  };
}

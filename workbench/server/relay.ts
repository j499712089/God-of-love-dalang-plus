import { loadConfig, saveConfig, VISION_MODEL_FALLBACKS } from "./config";

/** OpenAI 兼容的多模态 content part（vision）：文本或图片。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

/** 一次模型调用的 token 用量（缓存命中 token 单独拆出，供积分扣费按 0.15 折算）。 */
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens?: number;
};

export type RelayResult = {
  content: string;
  model: string;
  usage: TokenUsage;
};

export class RelayError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

async function callChat(
  base: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  json: boolean,
  signal: AbortSignal,
  maxTokens?: number,
  stream = false,
): Promise<Response> {
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      // 显式给足输出预算：不传时上游按渠道默认截断，长 JSON 输出会被切在半截
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(json ? { response_format: { type: "json_object" } } : {}),
      // 流式是防 Cloudflare 524 的根治手段：非流式时推理模型长输出易超
      // CF 100 秒源站硬限制被掐断（返回 524 HTML）；流式首字节秒回，
      // 只要数据在流动 CF 就不会断。stream_options 让末帧带回 usage。
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
    signal,
  });
}

type StreamParsed = {
  content: string;
  model: string;
  usage: TokenUsage;
};

/** 解析 OpenAI 兼容 SSE 流：逐帧累加 delta.content，usage/model 取携带的帧。
 *  onToken 回调（可选）在每帧 delta 到达时触发，供上游做流式推送到客户端。 */
async function readSSE(
  resp: Response,
  onToken?: (delta: string) => void,
): Promise<StreamParsed> {
  const body = resp.body;
  if (!body) throw new RelayError("中转站流式响应为空", 502);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let model = "";
  let finishReason = "";
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 以空行分帧；按行处理更稳（兼容 \r\n）
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          model?: string;
          choices?: { delta?: { content?: string }; finish_reason?: string }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          } | null;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          content += delta;
          onToken?.(delta);
        }
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          usage.input_tokens = chunk.usage.prompt_tokens ?? 0;
          usage.output_tokens = chunk.usage.completion_tokens ?? 0;
          usage.cache_hit_tokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
      } catch {
        /* 单帧解析失败跳过，不影响整体 */
      }
    }
  }
  // 截断检测：长 JSON 被切半截时，下游解析只会报「无法解析」，必须在这里给出真因
  if (finishReason === "length")
    throw new RelayError(
      `模型输出被截断（finish_reason=length，已输出 ${usage.output_tokens || "?"} tokens）——请减少图片数量或分批处理`,
      502,
    );
  return { content, model, usage };
}

/** 模型名大小写纠正：new-api 渠道按精确模型名匹配，配错大小写会 model_not_found。 */
async function resolveModelCase(
  base: string,
  apiKey: string,
  model: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const resp = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? [])
      .map((m) => String(m.id ?? ""))
      .filter(Boolean);
    return ids.find((id) => id.toLowerCase() === model.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/**
 * 调用中转站 OpenAI 兼容接口（大脑）。
 * 支持 JSON 输出模式；模型名配错大小写（model_not_found）时自动查 /v1/models
 * 纠正并重试一次，成功后回写配置，实现自愈。失败抛 RelayError。
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts?: {
    json?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    vision?: boolean;
    /** 输出 token 预算；长 JSON 任务（视觉读图/深层分析/OCR）必须显式给足，防上游默认截断 */
    maxTokens?: number;
    /** 用量回调：每次成功返回都会带上本次 TokenUsage，供上游（路由层）汇总扣费 */
    onUsage?: (usage: TokenUsage) => void;
    /** 流式逐 token 回调：每个 delta 到达时触发，供 /api/chat 推 SSE 到前端边收边显示 */
    onToken?: (delta: string) => void;
  },
): Promise<RelayResult> {
  const config = loadConfig();
  if (!config.relay.apiKey)
    throw new RelayError("尚未配置中转站 API Key，请在「模型设置」里填写", 503);
  const base = config.relay.baseUrl.replace(/\/+$/, "");
  // 带图请求自动切视觉模型（主模型渠道大概率不支持 vision，2026-09-24 实测）
  const model = opts?.vision && config.relay.visionModel ? config.relay.visionModel : config.relay.model;
  // 流式仅在「调用方显式要 onToken」且「非视觉读图」时启用：视觉渠道对 stream 支持不稳，
  // 且图片结果无逐字流式意义，保持一次性 JSON 解析更稳。
  const useStream = !!opts?.onToken && !opts?.vision;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? 180000,
  );
  const signal = opts?.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  try {
    let resp = await callChat(
      base,
      config.relay.apiKey,
      model,
      messages,
      opts?.json ?? false,
      signal,
      opts?.maxTokens,
      useStream,
    );
    let errText = "";
    if (!resp.ok && [404, 503].includes(resp.status)) {
      errText = await resp.text().catch(() => "");
      if (/model_not_found|no available channel/i.test(errText)) {
        const fixed = await resolveModelCase(
          base,
          config.relay.apiKey,
          model,
          signal,
        );
        if (fixed && fixed !== model) {
          resp = await callChat(
            base,
            config.relay.apiKey,
            fixed,
            messages,
            opts?.json ?? false,
            signal,
            opts?.maxTokens,
            useStream,
          );
          // 自愈成功：把正确大小写的模型名回写配置，下次直接命中
          if (resp.ok) {
            try {
              const cur = loadConfig();
              // 视觉模型名纠正写回 visionModel，主模型写回 model
              if (opts?.vision) saveConfig({ relay: { ...cur.relay, visionModel: fixed } });
              else saveConfig({ relay: { ...cur.relay, model: fixed } });
            } catch {
              /* 回写失败不影响本次结果 */
            }
          }
        }
      }
    }
    // 视觉请求降级：当前视觉模型返回「上游不可用」时（403 code:899 / 404 /
    // 400 上游服务暂不可用 / 429 号池限流 / 402 余额不足），按候选列表逐个尝试
    // 其它视觉模型，命中即自愈回写（terra 下线后自动切 astra）。
    if (!resp.ok && opts?.vision) {
      const st = resp.status;
      const isUnavailable = st === 400 || st === 402 || st === 403 || st === 404 || st === 429 || st === 503;
      if (isUnavailable) {
        if (!errText) errText = await resp.text().catch(() => "");
        const tried = new Set<string>([model]);
        for (const cand of VISION_MODEL_FALLBACKS) {
          if (tried.has(cand)) continue;
          tried.add(cand);
          let r2 = await callChat(
            base,
            config.relay.apiKey,
            cand,
            messages,
            opts?.json ?? false,
            signal,
            opts?.maxTokens,
          );
          if (r2.ok) {
            // 自愈：把可用的视觉模型回写配置
            try {
              const cur = loadConfig();
              saveConfig({ relay: { ...cur.relay, visionModel: cand } });
            } catch {
              /* 回写失败不影响本次结果 */
            }
            resp = r2;
            break;
          }
          // 404 可能是大小写问题，纠正一次再试
          if (r2.status === 404) {
            const fixed = await resolveModelCase(
              base,
              config.relay.apiKey,
              cand,
              signal,
            );
            if (fixed && fixed !== cand) {
              r2 = await callChat(
                base,
                config.relay.apiKey,
                fixed,
                messages,
                opts?.json ?? false,
                signal,
                opts?.maxTokens,
              );
              if (r2.ok) {
                try {
                  const cur = loadConfig();
                  saveConfig({ relay: { ...cur.relay, visionModel: fixed } });
                } catch {
                  /* ignore */
                }
                resp = r2;
                break;
              }
            }
          }
        }
      }
    }
    if (!resp.ok) {
      if (!errText) errText = await resp.text().catch(() => "");
      if (opts?.vision) {
        // 视觉渠道全挂时给一个能看懂的原因，避免前端一直「读取中」看不到头
        throw new RelayError(
          `图片识别暂时不可用：上游中转站当前没有可用的视觉模型渠道（可能限流 / 号池无可用资源 / 余额不足，已尝试全部候选视觉模型均失败）。请稍后重试；若持续失败，需联系中转站运营恢复图片渠道。原始返回：${resp.status}${errText ? ` ${errText.slice(0, 140)}` : ""}`,
          resp.status,
        );
      }
      throw new RelayError(
        `中转站返回 ${resp.status}${errText ? `：${errText.slice(0, 200)}` : ""}`,
        resp.status,
      );
    }
    // 成功：流式请求优先按 SSE 解析；非流式 / 中转站不支持流式（非 event-stream）自动回退一次性 JSON
    const ctype = resp.headers.get("content-type") || "";
    if (useStream && ctype.includes("text/event-stream")) {
      const parsed = await readSSE(resp, opts?.onToken);
      if (!parsed.content)
        throw new RelayError("中转站流式响应内容为空", 502);
      opts?.onUsage?.(parsed.usage);
      return {
        content: parsed.content,
        model: parsed.model || model,
        usage: parsed.usage,
      };
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
      model?: string;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    // 截断检测：长 JSON 被切半截时，下游解析只会报「无法解析」，必须在这里给出真因
    if (choice?.finish_reason === "length")
      throw new RelayError(
        `模型输出被截断（finish_reason=length，已输出 ${data.usage?.completion_tokens ?? "?"} tokens）——请减少图片数量或分批处理`,
        502,
      );
    const usage: TokenUsage = {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      // 缓存命中 token：OpenAI 兼容格式藏在 prompt_tokens_details.cached_tokens
      cache_hit_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    opts?.onUsage?.(usage);
    return {
      content,
      model: data.model || model,
      usage,
    };
  } catch (e) {
    if (e instanceof RelayError) throw e;
    if ((e as Error).name === "AbortError")
      throw new RelayError("中转站请求超时或已取消", 504);
    throw new RelayError(`中转站请求失败：${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

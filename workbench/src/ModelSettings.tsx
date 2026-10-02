import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch } from "./api";

type PublicConfig = {
  mode: "local" | "saas";
  relay: {
    baseUrl: string;
    model: string;
    visionModel: string;
    hasKey: boolean;
    keyMask: string;
  };
  embedding: {
    provider: "cloud" | "local" | "openai";
    baseUrl: string;
    model: string;
    hasKey: boolean;
    keyMask: string;
  };
  jev: {
    baseUrl: string;
    model: string;
    hasKey: boolean;
    keyMask: string;
  };
};

const PROVIDER_LABEL: Record<PublicConfig["embedding"]["provider"], string> = {
  cloud: "云端向量库（大浪服务器）",
  local: "本地模型（无需 key）",
  openai: "OpenAI 兼容 Embedding",
};

type TestState = { ok: boolean; detail: string };

/** 单机版「跑通」徽标：配置 + 连通测试都过了才算跑通（2026-09-30 主人定板）。 */
function TestBadge({
  state,
  testing,
}: {
  state: TestState | null;
  testing: boolean;
}) {
  if (testing) return <span className="ms-badge ms-badge--run">测试中…</span>;
  if (!state) return null;
  return state.ok ? (
    <span className="ms-badge ms-badge--ok">✓ 已跑通</span>
  ) : (
    <span className="ms-badge ms-badge--fail">✗ {state.detail}</span>
  );
}

export default function ModelSettings({ close }: { close: () => void }) {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [error, setError] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [embedKey, setEmbedKey] = useState("");
  const [jevKey, setJevKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 单机版连通测试：引导必须「配置 + 跑通」才隐藏，光有 key 不算数
  const [relayTest, setRelayTest] = useState<TestState | null>(null);
  const [embedTest, setEmbedTest] = useState<TestState | null>(null);
  const [jevTest, setJevTest] = useState<TestState | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch("/api/config");
        if (!r.ok) throw new Error("读取配置失败");
        setCfg((await r.json()) as PublicConfig);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  async function runTest() {
    if (testing) return;
    setTesting(true);
    setError("");
    try {
      const r = await apiFetch("/api/config/test");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "测试失败");
      const d = (await r.json()) as {
        relay: TestState;
        embedding: TestState;
        jev: TestState;
      };
      setRelayTest(d.relay);
      setEmbedTest(d.embedding);
      setJevTest(d.jev);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  // 单机模式：弹窗打开即自动测一轮（没配 key 也会返回「未配置」，引导因此保持可见）
  useEffect(() => {
    if (cfg?.mode === "local") void runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.mode]);

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const patch: Record<string, unknown> = {};
      const rk = relayKey.trim();
      const ek = embedKey.trim();
      const jk = jevKey.trim();
      if (rk) patch.relay = { apiKey: rk };
      if (ek) patch.embedding = { apiKey: ek };
      if (jk) patch.jev = { apiKey: jk };
      const r = await apiFetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error("保存失败");
      setSaved(true);
      setCfg((await r.json()) as PublicConfig);
      setRelayKey("");
      setEmbedKey("");
      setJevKey("");
      void runTest(); // 保存后立刻重测，跑通了引导才消失
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) {
    return (
      <div className="ms">
        {error ? (
          <p className="ms-error">{error}</p>
        ) : (
          <p className="ms-loading">加载配置…</p>
        )}
        <div className="ms-actions">
          <button className="secondary" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  // 单机模式：自己接中转站（地址锁定官方中转站），填 Key + license，保存一次永久生效。
  // GPT 与 Jev 同站不同分组、两个独立 Key（2026-10-01 主人定板）。
  if (cfg.mode === "local") {
    return (
      <div className="ms">
        <p className="ms-hint">
          单机版 · 分析大脑接官方中转站（地址已锁定），向量库接大浪云端（用 license），
          快速判断模型 Jev 也走官方中转站（地址已锁定）。三个 Key 配一次即永久生效，
          与本机其它客户端共用（<code>~/.dalang/config.json</code> 的 license 会自动复用）。
        </p>

        <div className="ms-group">
          <h3>
            分析大脑 · 中转站（GPT 分组） <TestBadge state={relayTest} testing={testing} />
          </h3>
          {(!cfg.relay.hasKey || relayTest?.ok === false) && (
            <p className="ms-guide">
              还没有 Key？<a href="https://api.foundfutureai.cn/" target="_blank" rel="noreferrer">打开官方中转站 api.foundfutureai.cn</a>
              {" "}注册购买（API Key 选 GPT-5.6-SOL），粘贴到下面保存即用。
            </p>
          )}
          <div className="ms-field">
            <span>Base URL（官方中转站，已锁定，不可改）</span>
            <input value={cfg.relay.baseUrl} readOnly className="ms-locked" />
          </div>
          <div className="ms-field">
            <span>中转站 API Key（GPT 分组）</span>
            <input
              value={relayKey}
              placeholder={
                cfg.relay.hasKey
                  ? `已配置 ${cfg.relay.keyMask}（重新粘贴可覆盖）`
                  : "粘贴 GPT 分组的 API Key"
              }
              onChange={(e) => setRelayKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="ms-field">
            <span>模型</span>
            <input value={cfg.relay.model} readOnly className="ms-locked" />
          </div>
        </div>

        <div className="ms-group">
          <h3>
            快速判断模型 · Jev（Jev 分组） <TestBadge state={jevTest} testing={testing} />
          </h3>
          {(!cfg.jev.hasKey || jevTest?.ok === false) && (
            <p className="ms-guide">
              还没有 Key？在官方中转站 <b>api.foundfutureai.cn</b> 开通 Jev 分组后，
              粘贴 <b>Jev 分组自己的 API Key</b>（与上面 GPT 的 Key 是两个 Key，同站不同分组）。
            </p>
          )}
          <div className="ms-field">
            <span>Base URL（官方中转站，已锁定，不可改）</span>
            <input value={cfg.jev.baseUrl} readOnly className="ms-locked" />
          </div>
          <div className="ms-field">
            <span>Jev 分组 API Key（独立于 GPT）</span>
            <input
              value={jevKey}
              placeholder={
                cfg.jev.hasKey
                  ? `已配置 ${cfg.jev.keyMask}（重新粘贴可覆盖）`
                  : "粘贴 Jev 分组的 API Key"
              }
              onChange={(e) => setJevKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="ms-field">
            <span>模型</span>
            <input value={cfg.jev.model} readOnly className="ms-locked" />
          </div>
        </div>

        <div className="ms-group">
          <h3>
            向量库 · 检索知识源 <TestBadge state={embedTest} testing={testing} />
          </h3>
          {(!cfg.embedding.hasKey || embedTest?.ok === false) && (
            <p className="ms-guide">
              还没有 license？加微信 <b>DLang099</b> 免费领取，粘贴到下面保存即用。
              （本机其它客户端已跑过 <code>configure</code> 的话这里自动复用，可留空。）
            </p>
          )}
          <div className="ms-field">
            <span>提供方</span>
            <input value={PROVIDER_LABEL[cfg.embedding.provider]} readOnly className="ms-locked" />
          </div>
          <div className="ms-field">
            <span>向量库 Key（大浪 license）</span>
            <input
              value={embedKey}
              placeholder={
                cfg.embedding.hasKey
                  ? `已配置 ${cfg.embedding.keyMask}（重新粘贴可覆盖）`
                  : "粘贴大浪 license（加微信 DLang099 领取）"
              }
              onChange={(e) => setEmbedKey(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        {error && <p className="ms-error">{error}</p>}
        {saved && <p className="ms-ok">已保存，配置即时生效。</p>}

        <div className="ms-actions">
          <button className="secondary" onClick={close}>
            关闭
          </button>
          <button className="secondary" disabled={testing} onClick={() => void runTest()}>
            {testing ? "测试中…" : "重新测试"}
          </button>
          <button
            className="primary"
            disabled={saving || (!relayKey.trim() && !embedKey.trim() && !jevKey.trim())}
            onClick={save}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    );
  }

  // SaaS 模式：key 由服务端统一注入，只读展示（线上多用户版）。
  return (
    <div className="ms">
      <p className="ms-hint">
        API Key 与向量库 Key 已由服务端统一注入，无需、也无法在客户端填写或查看。下方为当前生效的模型信息（只读）。
      </p>

      <div className="ms-group">
        <h3>分析大脑 · 中转站</h3>
        <div className="ms-readonly">
          <span>Base URL（官方中转站，已锁定）</span>
          <code>{cfg.relay.baseUrl}</code>
        </div>
        <div className="ms-readonly">
          <span>模型</span>
          <code>{cfg.relay.model}</code>
        </div>
        <div className="ms-readonly">
          <span>视觉模型</span>
          <code>{cfg.relay.visionModel}</code>
        </div>
      </div>

      <div className="ms-group">
        <h3>快速判断模型 · Jev</h3>
        <div className="ms-readonly">
          <span>Base URL（官方中转站，已锁定）</span>
          <code>{cfg.jev.baseUrl}</code>
        </div>
        <div className="ms-readonly">
          <span>模型</span>
          <code>{cfg.jev.model}</code>
        </div>
      </div>

      <div className="ms-group">
        <h3>向量库 · 检索知识源</h3>
        <div className="ms-readonly">
          <span>提供方</span>
          <code>{PROVIDER_LABEL[cfg.embedding.provider]}</code>
        </div>
        <div className="ms-readonly">
          <span>Base URL</span>
          <code>{cfg.embedding.baseUrl}</code>
        </div>
        <div className="ms-readonly">
          <span>Embedding 模型</span>
          <code>{cfg.embedding.model}</code>
        </div>
      </div>

      {error && <p className="ms-error">{error}</p>}

      <div className="ms-actions">
        <button className="secondary" onClick={close}>
          关闭
        </button>
      </div>
    </div>
  );
}

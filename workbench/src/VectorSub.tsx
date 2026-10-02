import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import QRCode from "react-qr-code";
import { Copy, KeyRound, Loader2 } from "lucide-react";

type VectorPkg = {
  id: string;
  name: string;
  months: number;
  priceYuan: number;
  discountLabel: string;
};

type VectorStatus = {
  enabled: boolean;
  subscribed: boolean;
  unlimited: boolean;
  expiresAt: number;
  active: boolean;
  key: string;
  keyMask: string;
};

type Paying = { codeUrl: string; orderId: string; pkg: VectorPkg };

/**
 * 向量库订阅面板：独立于积分计费（6.6 元/月）。
 * - 展示当前权限状态（是否开启 / 到期时间）
 * - 「获取 / 重新生成 key」：拿到只用于向量库调用的 dlv_ key
 * - 套餐续费：1/3/6/12 月（越多折扣越多），微信扫码支付
 */
export default function VectorSub({ close }: { close: () => void }) {
  const [status, setStatus] = useState<VectorStatus | null>(null);
  const [packages, setPackages] = useState<VectorPkg[]>([]);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [paying, setPaying] = useState<Paying | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const r = await apiFetch("/api/vector/status");
      if (r.ok) setStatus((await r.json()) as VectorStatus);
      else setError((await r.json().catch(() => ({}))).error || "状态加载失败");
      const p = await apiFetch("/api/vector/packages");
      if (p.ok) setPackages(((await p.json()) as { packages: VectorPkg[] }).packages ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function genKey() {
    if (status?.key && !window.confirm("重新生成会作废旧 key（旧 key 立即失效），确认？")) return;
    setError("");
    try {
      const r = await apiFetch("/api/vector/key", { method: "POST" });
      const d = (await r.json()) as VectorStatus & { key: string; error?: string };
      if (!r.ok) throw new Error(d.error || "签发失败");
      setKey(d.key);
      setStatus(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function pick(pkg: VectorPkg) {
    setError("");
    try {
      const r = await apiFetch("/api/vector/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: pkg.id }),
      });
      const d = (await r.json()) as { codeUrl?: string; orderId?: string; error?: string };
      if (r.ok && d.codeUrl && d.orderId) {
        setPaying({ codeUrl: d.codeUrl, orderId: d.orderId, pkg });
      } else {
        setError(d.error || "下单失败，请稍后重试");
      }
    } catch {
      setError("下单失败，请稍后重试");
    }
  }

  // 支付后轮询订单，credited 即刷新状态并标记完成
  useEffect(() => {
    if (!paying || done) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await apiFetch("/api/recharge/orders");
        if (r.ok) {
          const d = (await r.json()) as { orders: { orderId: string; status: string }[] };
          const o = (d.orders ?? []).find((x) => x.orderId === paying.orderId);
          if (o && o.status === "credited") {
            await load();
            setDone(true);
            return;
          }
        }
      } catch {
        /* 轮询失败不中断 */
      }
      if (!stop) window.setTimeout(poll, 2000);
    };
    poll();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paying, done]);

  function statusText(): { label: string; cls: string } {
    if (!status) return { label: "加载中…", cls: "" };
    if (status.enabled === false) return { label: "已关闭（无调用权限）", cls: "off" };
    if (status.unlimited) return { label: "永久权限", cls: "on" };
    if (status.active) {
      return {
        label: "可用 · 到期 " + new Date(status.expiresAt).toLocaleDateString("zh-CN"),
        cls: "on",
      };
    }
    return { label: "未订阅 / 已过期", cls: "warn" };
  }

  if (done) {
    return (
      <div className="recharge">
        <div className="recharge-done">
          <strong>订阅成功</strong>
          <span>向量库调用权限已延长，可关闭窗口继续使用。</span>
        </div>
        <button className="primary" onClick={close}>
          完成
        </button>
      </div>
    );
  }

  if (paying) {
    return (
      <div className="recharge">
        <div className="recharge-qr-wrap">
          <QRCode value={paying.codeUrl} size={180} fgColor="#1c2b24" />
        </div>
        <p className="recharge-qr-tip">
          请用微信扫一扫支付 <strong>¥{paying.pkg.priceYuan}</strong>（{paying.pkg.name}
          {paying.pkg.discountLabel ? `，${paying.pkg.discountLabel}` : ""}）
        </p>
        <p className="recharge-qr-sub">支付成功后自动延长权限，本窗口请勿关闭。</p>
        <div className="recharge-actions">
          <button className="secondary" onClick={() => setPaying(null)}>
            返回选套餐
          </button>
        </div>
      </div>
    );
  }

  const st = statusText();

  return (
    <div className="recharge">
      <div className="vector-status">
        <div className="vector-status-head">
          <span className={`vector-badge ${st.cls}`}>{st.label}</span>
          {status?.keyMask && <code className="vector-keymask">{status.keyMask}</code>}
        </div>
        <p className="vector-note">
          向量库 = 大浪知识库检索，独立计费（6.6 元/月），不消耗积分；积分只用于 GPT-5.6-SOL 模型调用。
        </p>
      </div>

      {key ? (
        <div className="vector-key-box">
          <div className="vector-key-line">
            <KeyRound size={14} />
            <code className="vector-key-full">{key}</code>
            <button
              className="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(key);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy size={13} /> {copied ? "已复制" : "复制"}
            </button>
          </div>
          <p className="vector-key-hint">
            请立即保存，此 key 只显示这一次；它只用于调用向量库（/api/vector/retrieve），拿 key 碰不到积分、档案或后台。
          </p>
        </div>
      ) : (
        <button className="primary" onClick={() => void genKey()}>
          <KeyRound size={14} /> {status?.key ? "重新生成 key" : "获取我的 key"}
        </button>
      )}

      {error && <p className="recharge-error">{error}</p>}

      <h4 className="vector-sec">订阅 / 续费（连续充越多折扣越多）</h4>
      <div className="recharge-grid">
        {packages.map((p) => (
          <button key={p.id} className="recharge-card" onClick={() => void pick(p)}>
            <span className="recharge-card-name">
              {p.name}
              {p.discountLabel ? ` · ${p.discountLabel}` : ""}
            </span>
            <span className="recharge-card-price">¥{p.priceYuan}</span>
            <span className="recharge-card-credits">{p.months} 个月调用权限</span>
          </button>
        ))}
      </div>

      {!packages.length && !error && (
        <p className="recharge-loading">
          <Loader2 size={14} className="spin" /> 套餐加载中…
        </p>
      )}
    </div>
  );
}

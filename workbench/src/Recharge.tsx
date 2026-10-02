import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import QRCode from "react-qr-code";

type Pkg = {
  id: string;
  name: string;
  priceYuan: number;
  baseCredits: number;
  bonusCredits: number;
  finalCredits: number;
};

type Paying = { codeUrl: string; orderId: string; pkg: Pkg };

/**
 * 充值弹窗：套餐选择 → 微信 Native 扫码 → 轮询订单状态自动入账。
 * 前端只拿 codeUrl 渲染二维码，绝不接触任何支付密钥。
 */
export default function Recharge({
  close,
  onCredits,
}: {
  close: () => void;
  onCredits: (c: number) => void;
}) {
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState<Paying | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch("/api/recharge/packages");
        if (r.ok) {
          const d = (await r.json()) as { packages: Pkg[] };
          setPackages(d.packages ?? []);
        } else {
          setError("套餐加载失败");
        }
      } catch {
        setError("套餐加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function pick(pkg: Pkg) {
    setError("");
    try {
      const r = await apiFetch("/api/recharge/create", {
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

  // 支付后轮询订单状态，credited 即视为到账并刷新余额。
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
            const b = await apiFetch("/api/credits/balance");
            if (b.ok) {
              const bd = (await b.json()) as { credits: number };
              onCredits(bd.credits);
            }
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
  }, [paying, done, onCredits]);

  if (done) {
    return (
      <div className="recharge">
        <div className="recharge-done">
          <strong>充值成功</strong>
          <span>积分已到账，可关闭窗口继续使用。</span>
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
          请用微信扫一扫支付 <strong>¥{paying.pkg.priceYuan}</strong>（{paying.pkg.name}）
        </p>
        <p className="recharge-qr-sub">支付成功后自动到账，本窗口请勿关闭。</p>
        <div className="recharge-actions">
          <button className="secondary" onClick={() => setPaying(null)}>
            返回选套餐
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="recharge">
      {loading ? (
        <p className="recharge-loading">套餐加载中…</p>
      ) : error ? (
        <>
          <p className="recharge-error">{error}</p>
          <button className="secondary" onClick={close}>
            关闭
          </button>
        </>
      ) : (
        <>
          <div className="recharge-grid">
            {packages.map((p) => (
              <button
                key={p.id}
                className="recharge-card"
                onClick={() => pick(p)}
              >
                <span className="recharge-card-name">{p.name}</span>
                <span className="recharge-card-price">¥{p.priceYuan}</span>
                <span className="recharge-card-credits">
                  {p.bonusCredits > 0 ? `到账 ${p.finalCredits} 分（含赠 ${p.bonusCredits}）` : `到账 ${p.finalCredits} 分`}
                </span>
              </button>
            ))}
          </div>
          <p className="recharge-note">1 元 = 100 积分，充值后余额长期有效。</p>
        </>
      )}
    </div>
  );
}

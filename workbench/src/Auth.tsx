import { useState } from "react";
import { Heart, Loader2 } from "lucide-react";
import { setSession, type AuthUser } from "./api";

type Mode = "login" | "register";

export default function Auth({
  onSuccess,
  initialMode = "login",
}: {
  onSuccess: (user: AuthUser) => void;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("请输入邮箱和密码");
      return;
    }
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body?.error || "操作失败，请重试");
      if (!body?.token || !body?.user) throw new Error("返回数据异常");
      setSession(body.token as string, body.user as AuthUser);
      onSuccess(body.user as AuthUser);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Heart size={20} className="auth-brand-heart" />
          <span>恋爱之神 · 大浪工作台</span>
        </div>

        <h1 className="auth-title">
          {mode === "login" ? "登录工作台" : "注册账号"}
        </h1>
        <p className="auth-sub">
          {mode === "login"
            ? "登录后进入聊天分析、档案库与大浪指导。"
            : "创建账号后即可使用全部分析能力。"}
        </p>

        <form className="auth-form" onSubmit={submit}>
          <label className="auth-field">
            <span>邮箱</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="auth-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder="至少 6 位"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : mode === "login" ? (
              "登录"
            ) : (
              "注册并进入"
            )}
          </button>
        </form>

        <button
          className="auth-switch"
          type="button"
          onClick={() => {
            setMode((m) => (m === "login" ? "register" : "login"));
            setError("");
          }}
        >
          {mode === "login"
            ? "还没有账号？去注册"
            : "已有账号？去登录"}
        </button>
      </div>
    </div>
  );
}

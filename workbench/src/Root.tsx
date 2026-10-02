import { useEffect, useState } from "react";
import Home from "./Home";
import Auth from "./Auth";
import App from "./App";
import {
  getToken,
  getUser,
  onSessionExpired,
  clearSession,
  setLocalMode,
  type AuthUser,
} from "./api";

type Screen = "home" | "auth" | "app";

export default function Root() {
  // 初始：有 token 直接进工作台（老用户免打扰；若 token 已失效，工作台内的请求会触发 401 跳回登录）。
  const [screen, setScreen] = useState<Screen>(() =>
    getToken() ? "app" : "home",
  );

  useEffect(() => {
    // 启动时探测运行模式：单机（后端 DALANG_MODE=local）→ 免登录直进工作台，
    // 否则维持 SaaS 的 token 判断。local 模式下 401/402 不再触发跳转/充值提示。
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        const local = d && d.mode === "local";
        setLocalMode(local);
        if (local) setScreen("app");
      })
      .catch(() => setLocalMode(false));

    // 会话失效（401）统一回到登录页。
    return onSessionExpired(() => setScreen("auth"));
  }, []);

  function enter() {
    if (getToken()) setScreen("app");
    else setScreen("auth");
  }

  function logout() {
    clearSession();
    setScreen("home");
  }

  if (screen === "home") {
    // 使用逻辑（2026-09-27 上线定板）：未登录 = 「注册 / 登录」；
    // 注册/登录成功后回到落地页（已登录态）出现「进入工作台」按钮。
    return (
      <Home
        authed={Boolean(getToken())}
        email={getUser()?.email ?? ""}
        onEnter={enter}
      />
    );
  }
  if (screen === "auth") {
    return (
      <Auth
        initialMode="register"
        onSuccess={(_user: AuthUser) => {
          void _user;
          setScreen("home");
        }}
      />
    );
  }
  return <App onLogout={logout} />;
}

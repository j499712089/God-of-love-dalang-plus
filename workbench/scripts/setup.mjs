#!/usr/bin/env node
// 大浪恋爱工作台 · 一键环境自检 + 初始化（npm run setup）
// 作用：在新机器上检查 Node / Python 环境、生成 server/config.json 骨架（不含密钥），
//       并打印首次配置指引。不联网、不改动任何密钥或档案数据。
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKBENCH_DIR = join(__dirname, "..");
const SERVER_DIR = join(WORKBENCH_DIR, "server");
const CONFIG_PATH = join(SERVER_DIR, "config.json");
const CONFIG_EXAMPLE = join(SERVER_DIR, "config.example.json");

const ok = (s) => console.log(`  [OK] ${s}`);
const warn = (s) => console.log(`  [!!] ${s}`);

function nodeVersion() {
  const m = process.version.match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function hasCmd(cmd) {
  const r = spawnSync(cmd, ["--version"], { shell: true, stdio: "ignore" });
  return r.status === 0;
}

console.log("大浪恋爱工作台 · 环境自检\n" + "=".repeat(40));

// 1. Node 版本
const nv = nodeVersion();
if (!nv) {
  warn("未检测到 Node 版本信息");
} else if (nv.major >= 22 && nv.minor >= 12) {
  ok(`Node ${process.version}（≥ 22.12，满足要求）`);
} else if (nv.major >= 22) {
  ok(`Node ${process.version}（22.x，建议 ≥ 22.12）`);
} else {
  warn(`Node ${process.version} 过低，需要 ≥ 22.12。请到 https://nodejs.org 升级`);
}

// 2. Python（仅档案库写操作需要，纯标准库）
if (hasCmd("python")) {
  ok("检测到 python（档案库功能可用）");
} else if (hasCmd("python3")) {
  ok("检测到 python3（档案库功能可用）");
} else {
  warn("未检测到 python，档案库写操作不可用（聊天分析不受影响）。可安装 Python 3 或在 .env 写 SYS_PYTHON=<python绝对路径>");
}

// 3. 依赖是否已装
const nodeModules = join(WORKBENCH_DIR, "node_modules");
if (existsSync(nodeModules)) {
  ok("node_modules 已存在（依赖已安装）");
} else {
  warn("node_modules 不存在，请先运行 npm install");
}

// 4. 生成 config.json 骨架（不含密钥；已存在则不覆盖）
if (!existsSync(CONFIG_PATH)) {
  try {
    const example = existsSync(CONFIG_EXAMPLE)
      ? readFileSync(CONFIG_EXAMPLE, "utf-8")
      : JSON.stringify(
          {
            relay: { baseUrl: "https://api.foundfutureai.cn/v1", apiKey: "", model: "gpt-5.6-sol" },
            embedding: { provider: "cloud", baseUrl: "https://dalang.wenmingjianyuce.cn", apiKey: "", model: "text-embedding-3-small" },
          },
          null,
          2,
        );
    writeFileSync(CONFIG_PATH, example, "utf-8");
    ok("已生成 server/config.json 骨架（密钥留空，稍后到页面「模型设置」填写）");
  } catch (e) {
    warn(`生成 config.json 失败：${e.message}`);
  }
} else {
  ok("server/config.json 已存在，跳过生成（不覆盖现有配置）");
}

// 5. 客户端统一配置是否存在（license）
const dalangCfg = join(homedir(), ".dalang", "config.json");
if (existsSync(dalangCfg)) {
  try {
    const c = JSON.parse(readFileSync(dalangCfg, "utf-8"));
    ok(c.license ? "检测到客户端 license（~/.dalang/config.json），工作台云端向量库将自动复用" : "~/.dalang/config.json 存在但无 license 字段");
  } catch {
    warn("~/.dalang/config.json 存在但解析失败");
  }
} else {
  warn("未检测到 ~/.dalang/config.json（云端向量库 license 尚未配置，可到页面「模型设置」粘贴，或运行 cloud_client.js configure）");
}

console.log("=".repeat(40));
console.log("下一步：npm run dev 启动后，打开 http://127.0.0.1:5178");
console.log("在右上角「模型设置」填中转站 API Key + 向量库 Key（license），保存一次即永久生效。");

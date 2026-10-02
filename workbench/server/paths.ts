import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

// 分发版路径规则：全部环境变量优先；fallback 只用通用命令 / 相对路径，
// 不写死任何本机绝对路径（脱敏，保证换机器开箱即用）。
const __dirname = dirname(fileURLToPath(import.meta.url));

/** workbench 项目根目录 */
export const WORKBENCH_DIR = join(__dirname, "..");

/**
 * 判断一个 python 可执行文件/命令是否真的能跑（返回版本号），失败返回 false。
 * 用于排除 Microsoft Store 的 python.exe 存根——那个占位程序被 spawn 会报
 * `spawnSync python EBUSY`（App Execution Alias 拒绝直接执行）。
 */
function pythonWorks(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Windows 上常见真 Python 命令（纯命令名，不带参数），按优先级探测。 */
const WIN_PY_CANDIDATES = ["py", "python3", "python"];

/**
 * 扫描 WorkBuddy 自带的 managed Python 绝对路径（不依赖进程 PATH）。
 * 形如 ~/.workbuddy/binaries/python/versions/<ver>/python.exe。
 * 用绝对路径 spawn 可彻底绕开 PATH 里 Microsoft Store 存根的 EBUSY 问题。
 */
function managedPythonPaths(): string[] {
  const out: string[] = [];
  try {
    const base = join(homedir(), ".workbuddy", "binaries", "python", "versions");
    if (!existsSync(base)) return out;
    for (const ver of readdirSync(base)) {
      const exe = join(base, ver, "python.exe");
      if (existsSync(exe)) out.push(exe);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 通用 Python（优先环境变量，其次 managed 绝对路径，再其次探测命令，杜绝 Store 存根 EBUSY）。
 * 返回的是「纯可执行文件路径或命令名」，供 execFileSync / spawn 直接使用。
 */
function defaultPython(): string {
  if (process.platform !== "win32") return "python3";
  // 1) managed Python 绝对路径优先：绕开 PATH，最稳
  for (const p of managedPythonPaths()) {
    if (pythonWorks(p)) return p;
  }
  // 2) 再探测 PATH 里的真 Python 命令
  for (const c of WIN_PY_CANDIDATES) {
    if (pythonWorks(c)) return c;
  }
  // 3) 全失败兜底 python（保留原行为，错误会以原始信息抛出供诊断）
  return "python";
}

/** 恋爱之神大浪技能根目录（仅本地向量库模式需要；默认指向 workbench 上一级 = 技能根） */
export const DALANG_SKILL_DIR =
  process.env.DALANG_SKILL_DIR || join(WORKBENCH_DIR, "..");

/** 向量库检索守护进程 + 向量库构建用的 Python（含 numpy + sentence-transformers，仅本地向量模式需要） */
export const ST_ENV_PYTHON = process.env.ST_ENV_PYTHON || defaultPython();

/** 跑 profile_cli.py / build_db.py 用的 Python（纯标准库） */
export const SYS_PYTHON = process.env.SYS_PYTHON || defaultPython();

/** 女生档案库（已迁入 workbench/profile_db，自包含） */
export const PROFILE_DB_DIR = join(WORKBENCH_DIR, "profile_db");

# -*- coding: utf-8 -*-
"""
女生档案库 · 数据构建脚本

读取 data/profiles/*.json → 重算兴趣度与排名 → 生成 data/index.json + data/db.js

用法（在 profile_db/ 目录下执行，脚本自动定位同级 data/）：
    python scripts/build_db.py
"""
import json
import os
import sys
import time

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _home():
    """用户主目录。Windows 必须用 USERPROFILE（git bash 的 HOME 是 POSIX /c/...，expanduser 会拼错路径）。"""
    if os.name == "nt":
        return os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.expanduser("~")


def _resolve_root():
    """与 profile_cli 完全一致的库根解析：统一配置 config.json > 库根 library.json；找不到即失败，禁止回退写技能包。

    注意：v2.7 之前只认 PKG/library.json，v2.6 起 write_pointer 不再写 PKG 副本；
    v2.11 起找不到有效用户库直接失败，绝不把 index.json/db.js 写入技能包。
    """
    # 1) 统一配置 ~/.dalang/config.json（key + 库根同文件，最高优先）
    try:
        up = os.path.join(_home(), ".dalang", "config.json")
        if os.path.isfile(up):
            with open(up, "rb") as f:
                ucfg = json.loads(f.read().decode("utf-8-sig"))
            ulib = (ucfg or {}).get("library_root") or ""
            if ulib.strip():
                return os.path.abspath(ulib)
    except Exception:
        pass
    # 2) 库根 library.json（init 写入的权威指针）
    for cand in (os.path.join(PKG, "library.json"),):
        try:
            if os.path.isfile(cand):
                with open(cand, "rb") as f:
                    cfg = json.loads(f.read().decode("utf-8-sig"))
                p = (cfg or {}).get("library_root") or ""
                if p.strip():
                    return os.path.abspath(p)
        except Exception:
            continue
    # 3) 找不到有效库根时必须失败，绝不回退写技能包（防止数据污染）
    raise SystemExit("[FAIL] 未找到有效档案库根：请先运行 profile_cli.py init --path <用户库目录>，禁止把 index.json/db.js 写入技能包")


ROOT = _resolve_root()
PROFILE_DIR = os.path.join(ROOT, "data", "profiles")
INDEX_PATH = os.path.join(ROOT, "data", "index.json")
DBJS_PATH = os.path.join(ROOT, "data", "db.js")

WEIGHTS = {"intent": 25, "speed": 20, "respond": 20, "match": 15, "truth": 10, "risk": 10}
ILLUSION_CAP = 30          # 社交平台幻觉命中 >=4 项时的兴趣度上限
VERDICTS = ("推进中", "观察中", "已止损")


def fail(msg):
    print("[FAIL] " + msg)
    sys.exit(1)


def load_profiles():
    if not os.path.isdir(PROFILE_DIR):
        fail("档案目录不存在: " + PROFILE_DIR)
    items = []
    for fn in sorted(os.listdir(PROFILE_DIR)):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(PROFILE_DIR, fn)
        with open(path, "r", encoding="utf-8") as f:
            try:
                p = json.load(f)
            except json.JSONDecodeError as e:
                fail("JSON 解析失败 %s: %s" % (fn, e))
        stem = fn[:-5]
        if p.get("id") != stem:
            fail("id 与文件名不一致: %s (id=%s)" % (fn, p.get("id")))
        for k in ("name", "platform", "verdict"):
            if not p.get(k):
                fail("%s 缺少必填字段 %s" % (fn, k))
        if p["verdict"] not in VERDICTS:
            fail("%s verdict 非法: %s" % (fn, p["verdict"]))
        items.append((path, p))
    return items


def recalc_interest(p):
    """按六项分解重算总分，并施加幻觉型上限与止损硬门。"""
    bd = p.get("interest_breakdown") or {}
    total = 0
    for key, cap in WEIGHTS.items():
        v = bd.get(key, 0)
        if not isinstance(v, int) or v < 0:
            fail("%s interest_breakdown.%s 必须为非负整数" % (p["id"], key))
        if v > cap:
            fail("%s interest_breakdown.%s=%d 超过满分 %d" % (p["id"], key, v, cap))
        total += v

    notes = []
    # 幻觉型硬门：inferences 中出现 6/6 或 >=4 命中描述
    illusion = any(
        "幻觉" in (inf.get("title", "") + inf.get("evidence", ""))
        for inf in p.get("inferences", [])
    )
    if illusion and total > ILLUSION_CAP:
        notes.append("幻觉型命中，兴趣度由 %d 锁至 %d" % (total, ILLUSION_CAP))
        total = ILLUSION_CAP
    if p["verdict"] == "已止损" and total > ILLUSION_CAP:
        notes.append("已止损，兴趣度由 %d 锁至 %d" % (total, ILLUSION_CAP))
        total = ILLUSION_CAP

    p["interest"] = total
    return total, notes


def main():
    items = load_profiles()
    if not items:
        print("[WARN] 档案目录为空，仍生成空库")

    now = int(time.time() * 1000)
    roster = []
    for path, p in items:
        total, notes = recalc_interest(p)
        p.setdefault("created", now)
        p.setdefault("updated", now)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(p, f, ensure_ascii=False, indent=2)
        for n in notes:
            print("  - %s: %s" % (p["name"], n))
        roster.append({
            "id": p["id"], "name": p["name"], "platform": p["platform"],
            "verdict": p["verdict"], "interest": total,
            "truth_level": p.get("truth_level", "未评"),
            "updated": p.get("updated", now),
        })

    # 排名：兴趣度降序 → 同分按更新时间降序
    roster.sort(key=lambda r: (-r["interest"], -r["updated"]))
    for i, r in enumerate(roster, 1):
        r["rank"] = i

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump({"updated": now, "roster": roster}, f, ensure_ascii=False, indent=2)

    full = {}
    for _, p in items:
        full[p["id"]] = p
    with open(DBJS_PATH, "w", encoding="utf-8") as f:
        f.write("// 自动生成，请勿手改。由 scripts/build_db.py 重建。\n")
        f.write("window.ROSTER = %s;\n" % json.dumps(roster, ensure_ascii=False, indent=2))
        f.write("window.PROFILES = %s;\n" % json.dumps(full, ensure_ascii=False, indent=2))

    print("[OK] 已重建 %d 份档案" % len(roster))
    print("[OK] index.json / db.js 已更新")
    print("\n兴趣度排行：")
    for r in roster:
        print("  #%d  %-8s %3d 分  %s  (%s)" % (
            r["rank"], r["name"], r["interest"], r["verdict"], r["platform"]))


if __name__ == "__main__":
    main()

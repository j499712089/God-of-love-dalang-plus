# -*- coding: utf-8 -*-
"""
女生档案库 · 后端 CRUD 命令行

一切档案写操作都必须经过本脚本，禁止 agent 手写 JSON 文件。
脚本从自身位置解析库根目录，因此自用版与 PLUS 分发版共用同一份实现。

子命令：
    new           新建档案（按固定模板生成骨架）
    list          列出全部档案与排名
    get           读取单份档案
    set           修改单个字段（支持 a.b 点号路径）
    patch         用 JSON 文件合并更新（局部覆盖）
    timeline-add  追加一条互动时间线（聊天记录/口诉入口）
    score         设置兴趣度六项分解
    verdict       设置结论（推进中/观察中/已止损）
    delete        删除档案（需 --force）
    validate      校验全库字段完整度与格式
    rebuild       重算兴趣度与排名，生成前端数据

用法示例：
    python profile_cli.py new --id lisi_tantan --name 李四 --platform 探探
    python profile_cli.py timeline-add --id lisi_tantan --t "第3轮" --who 她 --text "在忙" --gap "8h"
    python profile_cli.py score --id lisi_tantan --intent 20 --speed 15 --respond 10 --match 12 --truth 8 --risk 9
    python profile_cli.py validate
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILE_DIR = os.path.join(ROOT, "data", "profiles")
BACKUP_DIR = os.path.join(ROOT, "data", "_backup")
BUILD = os.path.join(ROOT, "scripts", "build_db.py")

VERDICTS = ("推进中", "观察中", "已止损")
TRUTH_LEVELS = ("高", "中-高", "中", "中-低", "低", "未评")
SCORE_KEYS = ("intent", "speed", "respond", "match", "truth", "risk")
SCORE_CAPS = {"intent": 25, "speed": 20, "respond": 20, "match": 15, "truth": 10, "risk": 10}
ID_RE = re.compile(r"^[a-z0-9]+(_[a-z0-9]+)+$")

# 固定模板：新建档案一律生成此骨架，字段不得增删改名
TEMPLATE = {
    "id": "", "name": "", "platform": "", "verdict": "观察中",
    "interest": 0,
    "interest_breakdown": {k: 0 for k in SCORE_KEYS},
    "truth_level": "未评",
    "created": 0, "updated": 0,
    "facts": {},
    "photos": [],
    "truth_check": [],
    "truth_note": "",
    "inferences": [],
    "position": {"chance": [], "risk": []},
    "plan": {
        "stage": "", "opener": "", "opener_why": [], "rounds": [],
        "invite_rules": [], "stop_rules": [], "funnel_note": "",
    },
    "gaps": [],
    "timeline": [],
    "summary": "",
}

REQUIRED_TOP = list(TEMPLATE.keys())


def die(msg):
    print("[FAIL] " + msg)
    sys.exit(1)


def ok(msg):
    print("[OK] " + msg)


def path_of(pid):
    return os.path.join(PROFILE_DIR, pid + ".json")


def load(pid):
    p = path_of(pid)
    if not os.path.isfile(p):
        die("档案不存在: %s\n先运行 new 建档，或用 list 查看现有 id" % pid)
    with open(p, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError as e:
            die("JSON 损坏 %s: %s" % (pid, e))


def backup(pid):
    src = path_of(pid)
    if not os.path.isfile(src):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    shutil.copy2(src, os.path.join(BACKUP_DIR, "%s.%s.json" % (pid, stamp)))


def save(prof, do_backup=True):
    os.makedirs(PROFILE_DIR, exist_ok=True)
    if do_backup:
        backup(prof["id"])
    prof["updated"] = int(time.time() * 1000)
    with open(path_of(prof["id"]), "w", encoding="utf-8") as f:
        json.dump(prof, f, ensure_ascii=False, indent=2)


def rebuild():
    r = subprocess.run([sys.executable, BUILD], capture_output=True)
    out = (r.stdout or b"").decode("utf-8", "replace")
    err = (r.stderr or b"").decode("utf-8", "replace")
    print(out.rstrip())
    if r.returncode != 0:
        die("重建失败:\n" + err.strip())


def all_ids():
    if not os.path.isdir(PROFILE_DIR):
        return []
    return sorted(f[:-5] for f in os.listdir(PROFILE_DIR) if f.endswith(".json"))


# ---------- 点号路径读写 ----------
def dig(obj, dotted, create=False):
    """返回 (父容器, 末级键)。"""
    parts = dotted.split(".")
    cur = obj
    for k in parts[:-1]:
        if isinstance(cur, list):
            try:
                cur = cur[int(k)]
            except (ValueError, IndexError):
                die("路径越界: %s" % dotted)
        elif isinstance(cur, dict):
            if k not in cur:
                if not create:
                    die("字段不存在: %s（禁止新增模板外字段）" % dotted)
                cur[k] = {}
            cur = cur[k]
        else:
            die("路径不可深入: %s" % dotted)
    return cur, parts[-1]


def coerce(raw):
    """尝试把命令行字符串解析成 JSON 值，失败则按字符串处理。"""
    s = raw.strip()
    if s and (s[0] in "[{" or s in ("true", "false", "null") or re.match(r"^-?\d+$", s)):
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            pass
    return raw


# ---------- 子命令 ----------
def cmd_new(a):
    if not ID_RE.match(a.id):
        die("id 非法: %s\n必须为「拼音_平台」小写下划线格式，如 lisi_tantan" % a.id)
    if os.path.isfile(path_of(a.id)):
        die("档案已存在: %s\n同一个人禁止重复建档，请改用 set / patch 更新" % a.id)
    if a.verdict not in VERDICTS:
        die("verdict 非法: %s（可选 %s）" % (a.verdict, "/".join(VERDICTS)))
    prof = json.loads(json.dumps(TEMPLATE))
    prof["id"] = a.id
    prof["name"] = a.name
    prof["platform"] = a.platform
    prof["verdict"] = a.verdict
    prof["created"] = int(time.time() * 1000)
    save(prof, do_backup=False)
    ok("已建档 %s（%s / %s），字段骨架已按固定模板生成" % (a.id, a.name, a.platform))
    print("下一步：用 set / patch 填充 facts、photos、truth_check、inferences、plan，再跑 validate")
    rebuild()


def cmd_list(a):
    ids = all_ids()
    if not ids:
        print("（档案库为空）")
        return
    rows = []
    for pid in ids:
        p = load(pid)
        rows.append((p.get("interest", 0), p))
    rows.sort(key=lambda r: -r[0])
    print("%-4s %-22s %-8s %-6s %-8s %s" % ("#", "id", "姓名", "兴趣", "结论", "平台"))
    for i, (score, p) in enumerate(rows, 1):
        print("%-4d %-22s %-8s %-6d %-8s %s" % (
            i, p["id"], p.get("name", ""), score, p.get("verdict", ""), p.get("platform", "")))


def cmd_get(a):
    p = load(a.id)
    if a.field:
        parent, key = dig(p, a.field)
        val = parent[key] if isinstance(parent, dict) else parent[int(key)]
        print(json.dumps(val, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(p, ensure_ascii=False, indent=2))


def cmd_set(a):
    p = load(a.id)
    root = a.field.split(".")[0]
    if root not in REQUIRED_TOP:
        die("字段不在固定模板内，禁止新增: %s\n可用顶层字段: %s" % (root, ", ".join(REQUIRED_TOP)))
    parent, key = dig(p, a.field)
    # facts 是自由键值表，允许新增键；其余结构化字段禁止凭空造键
    if isinstance(parent, dict) and key not in parent and not a.field.startswith("facts"):
        die("字段不存在: %s（结构化字段禁止新增键，facts 除外）" % a.field)
    val = coerce(a.value)
    if a.field == "verdict" and val not in VERDICTS:
        die("verdict 非法: %s（可选 %s）" % (val, "/".join(VERDICTS)))
    if a.field == "truth_level" and val not in TRUTH_LEVELS:
        die("truth_level 非法: %s（可选 %s）" % (val, "/".join(TRUTH_LEVELS)))
    if a.field == "interest":
        die("interest 禁止手填，请用 score 子命令设置六项分解")
    if isinstance(parent, list):
        parent[int(key)] = val
    else:
        parent[key] = val
    save(p)
    ok("%s.%s 已更新" % (a.id, a.field))
    rebuild()


def cmd_patch(a):
    p = load(a.id)
    with open(a.file, "r", encoding="utf-8") as f:
        try:
            delta = json.load(f)
        except json.JSONDecodeError as e:
            die("补丁 JSON 无效: %s" % e)
    if not isinstance(delta, dict):
        die("补丁必须是 JSON 对象")
    unknown = [k for k in delta if k not in REQUIRED_TOP]
    if unknown:
        die("补丁含模板外字段，禁止写入: %s" % ", ".join(unknown))
    if "interest" in delta:
        die("interest 禁止手填，请用 score 子命令")
    if "id" in delta and delta["id"] != a.id:
        die("补丁不得改写 id")
    for k, v in delta.items():
        p[k] = v
    save(p)
    ok("%s 已合并 %d 个字段: %s" % (a.id, len(delta), ", ".join(delta)))
    rebuild()


def cmd_timeline_add(a):
    p = load(a.id)
    entry = {"t": a.t, "who": a.who, "text": a.text, "gap": a.gap}
    p["timeline"].append(entry)
    save(p)
    ok("%s 时间线 +1（共 %d 条）：[%s] %s：%s（间隔 %s）" % (
        a.id, len(p["timeline"]), a.t, a.who, a.text, a.gap))
    if a.gap in ("未知", "unknown", "?"):
        print("[WARN] 间隔标为未知 —— 按时间间隔硬门，必须向用户索要时间戳后回填，且本轮不得下兴趣度结论")
    rebuild()


def cmd_score(a):
    p = load(a.id)
    bd = p["interest_breakdown"]
    changed = []
    for k in SCORE_KEYS:
        v = getattr(a, k)
        if v is None:
            continue
        if v < 0 or v > SCORE_CAPS[k]:
            die("%s=%d 越界（0-%d）" % (k, v, SCORE_CAPS[k]))
        bd[k] = v
        changed.append("%s=%d" % (k, v))
    if not changed:
        die("未提供任何分项，示例: --intent 20 --speed 15")
    if not p["timeline"] and bd.get("respond", 0) > 0:
        die("timeline 为空时 respond 必须为 0（无聊天记录不得凭资料想象响应质量）")
    save(p)
    ok("%s 分项已更新: %s" % (a.id, " ".join(changed)))
    rebuild()


def cmd_verdict(a):
    p = load(a.id)
    if a.value not in VERDICTS:
        die("verdict 非法: %s（可选 %s）" % (a.value, "/".join(VERDICTS)))
    old = p.get("verdict")
    p["verdict"] = a.value
    save(p)
    ok("%s 结论 %s → %s" % (a.id, old, a.value))
    rebuild()


def cmd_delete(a):
    src = path_of(a.id)
    if not os.path.isfile(src):
        die("档案不存在: %s" % a.id)
    if not a.force:
        die("删除是不可逆操作，确认后请加 --force（会先自动备份到 data/_backup/）")
    backup(a.id)
    os.remove(src)
    ok("%s 已删除，备份保留在 data/_backup/" % a.id)
    rebuild()


# ---------- 颗粒度校验 ----------
# 硬门：低于此标准视为「资料卡颗粒度不够」，不得交付
FLOOR = {
    "facts": 8,        # 事实键值条数
    "photos": 1,       # 每张必须带 content + decode
    "truth_check": 5,  # 真实性五维，缺一维即不合格
    "inferences": 3,   # 每条必须四件套
}


def check_one(p):
    errs, warns = [], []
    pid = p.get("id", "?")

    for k in REQUIRED_TOP:
        if k not in p:
            errs.append("缺少顶层字段 %s" % k)
    if errs:
        return errs, warns

    if not ID_RE.match(pid):
        errs.append("id 格式非法（须拼音_平台）")
    if p["verdict"] not in VERDICTS:
        errs.append("verdict 非法: %s" % p["verdict"])
    if p.get("truth_level") not in TRUTH_LEVELS:
        errs.append("truth_level 非法: %s" % p.get("truth_level"))

    for k in SCORE_KEYS:
        v = p["interest_breakdown"].get(k)
        if not isinstance(v, int) or v < 0 or v > SCORE_CAPS[k]:
            errs.append("interest_breakdown.%s 非法: %r（0-%d）" % (k, v, SCORE_CAPS[k]))

    if len(p["facts"]) < FLOOR["facts"]:
        errs.append("facts 仅 %d 条，低于 %d 条硬门（平台/年龄/职业/属地/标签/择偶/动态文案/作息…）"
                    % (len(p["facts"]), FLOOR["facts"]))

    if len(p["photos"]) < FLOOR["photos"]:
        errs.append("photos 为空：每张照片必须给出 content + decode 解码")
    for i, ph in enumerate(p["photos"]):
        if not ph.get("content") or not ph.get("decode"):
            errs.append("photos[%d] 缺 content 或 decode（禁止只描述不解码）" % i)

    if len(p["truth_check"]) < FLOOR["truth_check"]:
        errs.append("truth_check 仅 %d 维，真实性核验必须五维齐全" % len(p["truth_check"]))
    for i, tc in enumerate(p["truth_check"]):
        if not tc.get("dim") or not tc.get("result") or not tc.get("level"):
            errs.append("truth_check[%d] 缺 dim/result/level" % i)

    if len(p["inferences"]) < FLOOR["inferences"]:
        errs.append("inferences 仅 %d 条，低于 %d 条硬门" % (len(p["inferences"]), FLOOR["inferences"]))
    for i, inf in enumerate(p["inferences"]):
        miss = [k for k in ("title", "confidence", "evidence", "readings", "means") if not inf.get(k)]
        if miss:
            errs.append("inferences[%d] 缺四件套字段: %s" % (i, ", ".join(miss)))
        elif len(inf["readings"]) < 2 and inf.get("confidence") != "信息不足":
            errs.append("inferences[%d]「%s」只给 1 种解释，必须≥2 种（信息不足除外）"
                        % (i, inf["title"]))

    pos = p["position"]
    if not pos.get("chance") and not pos.get("risk"):
        errs.append("position 机会与风险全空")
    pl = p["plan"]
    for k in ("stage", "opener", "funnel_note"):
        if not pl.get(k):
            errs.append("plan.%s 为空" % k)
    if not pl.get("rounds"):
        errs.append("plan.rounds 为空：必须给出接下来 1-3 轮节奏")
    if not pl.get("stop_rules"):
        errs.append("plan.stop_rules 为空：必须给出止损条件")
    if not p.get("summary"):
        errs.append("summary 为空")

    if not p["timeline"]:
        warns.append("timeline 为空 —— 尚无聊天记录，respond 必须为 0，后续用 timeline-add 逐轮补录")
    else:
        for i, t in enumerate(p["timeline"]):
            if not t.get("gap"):
                warns.append("timeline[%d] 缺 gap（间隔是第一位硬数据）" % i)
    if not p["timeline"] and p["interest_breakdown"].get("respond", 0) > 0:
        errs.append("无 timeline 却给了 respond 分，违反响应质量取证规则")
    if not p.get("gaps") and p["verdict"] == "观察中":
        warns.append("gaps 为空 —— 观察中的档案通常仍有待确认变量")

    return errs, warns


def cmd_validate(a):
    ids = [a.id] if a.id else all_ids()
    if not ids:
        print("（档案库为空）")
        return
    bad = 0
    for pid in ids:
        errs, warns = check_one(load(pid))
        if errs:
            bad += 1
            print("[FAIL] %s" % pid)
            for e in errs:
                print("   × " + e)
        else:
            print("[OK]   %s 颗粒度达标" % pid)
        for w in warns:
            print("   ! " + w)
    print()
    if bad:
        die("%d/%d 份档案未达颗粒度硬门，补全后重跑 validate" % (bad, len(ids)))
    ok("全部 %d 份档案通过校验" % len(ids))


def cmd_rebuild(a):
    rebuild()


def build_parser():
    ap = argparse.ArgumentParser(prog="profile_cli", description="女生档案库后端 CRUD")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("new", help="新建档案（固定模板骨架）")
    p.add_argument("--id", required=True, help="拼音_平台，如 lisi_tantan")
    p.add_argument("--name", required=True)
    p.add_argument("--platform", required=True)
    p.add_argument("--verdict", default="观察中", choices=VERDICTS)
    p.set_defaults(func=cmd_new)

    p = sub.add_parser("list", help="列出全部档案与排名")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", help="读取档案或单个字段")
    p.add_argument("--id", required=True)
    p.add_argument("--field", help="点号路径，如 plan.rounds")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("set", help="修改单个字段")
    p.add_argument("--id", required=True)
    p.add_argument("--field", required=True, help="点号路径，如 facts.职业标签")
    p.add_argument("--value", required=True, help="标量或 JSON 字面量")
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("patch", help="用 JSON 文件局部合并")
    p.add_argument("--id", required=True)
    p.add_argument("--file", required=True)
    p.set_defaults(func=cmd_patch)

    p = sub.add_parser("timeline-add", help="追加一条互动时间线")
    p.add_argument("--id", required=True)
    p.add_argument("--t", required=True, help="轮次或时间点，如 第3轮 / 8月28日")
    p.add_argument("--who", required=True, help="用户 / 她")
    p.add_argument("--text", required=True, help="原话，保持原样含表情")
    p.add_argument("--gap", required=True, help="与上一条的真实间隔，未知写「未知」")
    p.set_defaults(func=cmd_timeline_add)

    p = sub.add_parser("score", help="设置兴趣度六项分解")
    p.add_argument("--id", required=True)
    for k in SCORE_KEYS:
        p.add_argument("--" + k, type=int, help="0-%d" % SCORE_CAPS[k])
    p.set_defaults(func=cmd_score)

    p = sub.add_parser("verdict", help="设置结论")
    p.add_argument("--id", required=True)
    p.add_argument("--value", required=True, choices=VERDICTS)
    p.set_defaults(func=cmd_verdict)

    p = sub.add_parser("delete", help="删除档案（先备份）")
    p.add_argument("--id", required=True)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_delete)

    p = sub.add_parser("validate", help="校验颗粒度与格式")
    p.add_argument("--id", help="省略则校验全库")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("rebuild", help="重算兴趣度与排名")
    p.set_defaults(func=cmd_rebuild)
    return ap


if __name__ == "__main__":
    args = build_parser().parse_args()
    args.func(args)



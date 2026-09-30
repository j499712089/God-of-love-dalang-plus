# -*- coding: utf-8 -*-
"""女生档案库本机后端。仅监听 127.0.0.1，前端自动调用，无需目录授权。"""
import argparse
import json
import mimetypes
import os
import subprocess
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote, urlparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(SCRIPT_DIR, "build_db.py")


def user_home():
    if os.name == "nt":
        return os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.expanduser("~")


def configured_root():
    p = os.path.join(user_home(), ".dalang", "config.json")
    if not os.path.isfile(p):
        raise SystemExit("[FAIL] 未找到 ~/.dalang/config.json，请先 init 配置档案库")
    with open(p, "rb") as f:
        cfg = json.loads(f.read().decode("utf-8-sig"))
    root = os.path.abspath((cfg or {}).get("library_root") or "")
    if not root or not os.path.isdir(os.path.join(root, "data", "profiles")):
        raise SystemExit("[FAIL] config.json 的 library_root 无效，请先 init --path <库根>")
    return root


def rebuild(root):
    env = os.environ.copy()
    env["DALANG_LIB"] = root
    r = subprocess.run([sys.executable, BUILD], env=env, capture_output=True)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).decode("utf-8", "replace"))


class Handler(SimpleHTTPRequestHandler):
    root = ""

    def log_message(self, fmt, *args):
        sys.stdout.write("[HTTP] " + fmt % args + "\n")

    def end_headers(self):
        # 页面可能从 file:// 或其他本机来源打开；仅本机服务，允许本地前端调用
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def translate_path(self, path):
        # SimpleHTTPRequestHandler 默认以当前工作目录为根；这里必须固定到用户库根
        rel = unquote(urlparse(path).path).lstrip("/\\")
        full = os.path.abspath(os.path.join(self.root, rel))
        if os.path.commonpath([self.root, full]) != self.root:
            return os.path.join(self.root, "index.html")
        return full

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_json(self, status, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def api_profile_id(self):
        path = urlparse(self.path).path
        prefix = "/api/profiles/"
        return unquote(path[len(prefix):]) if path.startswith(prefix) else None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            items = []
            d = os.path.join(self.root, "data", "profiles")
            for fn in sorted(os.listdir(d)):
                if fn.endswith(".json"):
                    with open(os.path.join(d, fn), "r", encoding="utf-8-sig") as f:
                        items.append(json.load(f))
            return self.send_json(200, {"ok": True, "connected": True, "library_root": self.root, "profiles": items})
        return super().do_GET()

    def do_PUT(self):
        pid = self.api_profile_id()
        if not pid or not pid.replace("_", "").isalnum():
            return self.send_json(400, {"ok": False, "error": "INVALID_ID"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            obj = json.loads(self.rfile.read(n).decode("utf-8"))
            obj["id"] = pid
            out = os.path.join(self.root, "data", "profiles", pid + ".json")
            with open(out, "w", encoding="utf-8", newline="\n") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
            rebuild(self.root)
            return self.send_json(200, {"ok": True, "profile": out})
        except Exception as e:
            return self.send_json(500, {"ok": False, "error": str(e)})

    def do_DELETE(self):
        pid = self.api_profile_id()
        if not pid:
            return self.send_json(400, {"ok": False, "error": "INVALID_ID"})
        p = os.path.join(self.root, "data", "profiles", pid + ".json")
        if os.path.isfile(p):
            os.remove(p)
        try:
            rebuild(self.root)
            return self.send_json(200, {"ok": True})
        except Exception as e:
            return self.send_json(500, {"ok": False, "error": str(e)})

    def translate_path(self, path):
        rel = urlparse(path).path.lstrip("/") or "index.html"
        rel = os.path.normpath(unquote(rel)).lstrip("/\\")
        full = os.path.abspath(os.path.join(self.root, rel))
        if os.path.commonpath([self.root, full]) != self.root:
            return os.path.join(self.root, "index.html")
        return full


def main():
    ap = argparse.ArgumentParser(description="女生档案库本机 API 服务")
    ap.add_argument("--lib", help="库根；不填读取 ~/.dalang/config.json")
    ap.add_argument("--port", type=int, default=39123)
    args = ap.parse_args()
    root = os.path.abspath(args.lib) if args.lib else configured_root()
    Handler.root = root
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("[OK] 档案库后端已启动")
    print("  库根: " + root)
    print("  看板: http://127.0.0.1:%d/" % args.port)
    print("  API:  http://127.0.0.1:%d/api/state" % args.port)
    httpd.serve_forever()


if __name__ == "__main__":
    main()

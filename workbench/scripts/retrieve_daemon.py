#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
恋爱之神大浪 · 向量检索常驻守护进程

供 workbench 后端（Node）通过 stdin/stdout JSON-lines 协议调用。
启动时一次性加载 vector_db + embedding 编码器，之后每次检索只做一次矩阵点积，
避免每次 spawn 进程重复加载模型（~数秒）。

Embedding 提供方（通过环境变量配置，由 Node 后端从 config.json 注入）：
  - local（默认）：本地 sentence-transformers，无需 key，向量 384 维
  - openai：OpenAI 兼容 /embeddings 接口，需 base_url + api_key + model

协议（每行一个 JSON）：
  输入  -> {"id": "<uuid>", "query": "<检索文本>", "top_k": 5}
  输出  <- {"id": "<uuid>", "ok": true, "cases": [...], "rules": [...], "templates": [...], "strategies": [...]}
  就绪  <- {"ready": true, "provider": "local", "dims": 384}   （模型加载完成后第一行）

依赖：st-env 的 python.exe（含 numpy + sentence-transformers）
用法：<st-env python> scripts/retrieve_daemon.py
"""
import json
import os
import sys
from pathlib import Path


def clip(data: dict, keys):
    return {k: data.get(k) for k in keys if data.get(k)}


def build_embedder(provider: str, dalang: Path):
    """返回 (embed(text)->numpy.ndarray, dims, label)。"""
    sys.path.insert(0, str(dalang / "scripts"))

    if provider == "openai":
        import numpy as np
        import urllib.request

        base = os.environ.get("DALANG_EMBED_BASE_URL", "").rstrip("/")
        key = os.environ.get("DALANG_EMBED_API_KEY", "")
        model = os.environ.get("DALANG_EMBED_MODEL", "text-embedding-3-small")
        if not base or not key:
            raise RuntimeError("OpenAI Embedding 缺少 base_url 或 api_key")

        def embed(text: str):
            url = base + "/embeddings"
            payload = json.dumps({"model": model, "input": [text]}).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + key,
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return np.asarray(data["data"][0]["embedding"], dtype="float32")

        return embed, None, "openai:" + model

    # 本地 sentence-transformers（默认，无需 key）
    from build_vector_db import load_encoder, resolve_local_model  # noqa: E402

    encoder = load_encoder(resolve_local_model())

    def embed(text: str):
        return encoder.encode(text, convert_to_numpy=True)

    return embed, 384, "local"


def main() -> None:
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    dalang_dir = os.environ.get(
        "DALANG_SKILL_DIR",
        str(Path(__file__).resolve().parents[2]),
    )
    dalang = Path(dalang_dir)

    import numpy as np

    db_dir = dalang / "vector_db"
    embeddings = np.load(db_dir / "embeddings.npz")["embeddings"]
    with open(db_dir / "index.json", "r", encoding="utf-8") as f:
        index = json.load(f)

    provider = os.environ.get("DALANG_EMBED_PROVIDER", "local")
    embed, dims, label = build_embedder(provider, dalang)

    def search(query: str, top_k: int):
        qv = np.asarray(embed(query), dtype="float32")
        if dims and qv.shape[0] != dims:
            raise RuntimeError(
                "Embedding 维度不匹配：当前 %d 维，向量库 %d 维。"
                "切换 Embedding 提供方后需重建向量库。" % (qv.shape[0], dims)
            )
        norms = np.linalg.norm(embeddings, axis=1)
        qn = np.linalg.norm(qv)
        sims = np.dot(embeddings, qv) / (norms * qn + 1e-9)
        order = np.argsort(sims)[::-1][: top_k * 6]
        return order, sims

    sys.stdout.write(
        json.dumps({"ready": True, "provider": label, "dims": dims}, ensure_ascii=False)
        + "\n"
    )
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        qid = req.get("id", "")
        query = req.get("query", "") or " "
        top_k = max(1, min(int(req.get("top_k", 5)), 10))

        try:
            order, sims = search(query, top_k)
            cases, rules, templates, strategies = [], [], [], []
            for idx in order:
                item = index[idx]
                sim = round(float(sims[idx]), 3)
                kind = item["type"]
                d = item["data"]
                if kind == "case" and len(cases) < top_k:
                    cases.append(
                        {
                            "similarity": sim,
                            "situation": d.get("situation", ""),
                            "stage": d.get("stage", ""),
                            "analysis": d.get("analysis", ""),
                            "recommendation": d.get("recommendation", ""),
                            "key_signals": d.get("key_signals", []),
                            "risk_signals": d.get("risk_signals", []),
                        }
                    )
                elif kind == "rule" and len(rules) < top_k:
                    rules.append(
                        {
                            "similarity": sim,
                            "category": d.get("category", ""),
                            "priority": d.get("priority", ""),
                            "rule": d.get("rule", ""),
                            "explanation": d.get("explanation", ""),
                        }
                    )
                elif kind == "template" and len(templates) < top_k:
                    templates.append(
                        {
                            "similarity": sim,
                            "scenario": d.get("scenario", ""),
                            "stage": d.get("stage", ""),
                            "template": d.get("template", ""),
                            "explanation": d.get("explanation", ""),
                        }
                    )
                elif kind == "strategy" and len(strategies) < top_k:
                    strategies.append(
                        {
                            "similarity": sim,
                            "title": d.get("title", ""),
                            "window_10": d.get("window_10", ""),
                            "timing": d.get("timing", ""),
                            "your_moves": d.get("your_moves", []),
                            "result": d.get("result", ""),
                        }
                    )

            resp = {
                "id": qid,
                "ok": True,
                "cases": cases,
                "rules": rules,
                "templates": templates,
                "strategies": strategies,
            }
        except Exception as exc:  # noqa: BLE001
            resp = {"id": qid, "ok": False, "error": str(exc)}

        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

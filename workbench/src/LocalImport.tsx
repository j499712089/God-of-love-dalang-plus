import { useRef, useState } from "react";
import { Upload, FolderOpen, FileJson, Loader2, CheckCircle2 } from "lucide-react";
import { apiFetch } from "./api";

type ParsedProfile = Record<string, unknown> & {
  id: string;
  name: string;
  platform?: string;
  verdict?: string;
  interest?: number;
};

function isProfile(o: unknown): o is ParsedProfile {
  return (
    !!o &&
    typeof o === "object" &&
    typeof (o as Record<string, unknown>).id === "string" &&
    typeof (o as Record<string, unknown>).name === "string"
  );
}

/** 从 db.js / 内嵌 HTML 里抽出 window.PROFILES = {...}（平衡括号扫描）。 */
function extractFromJs(text: string): ParsedProfile[] {
  const idx = text.indexOf("window.PROFILES");
  if (idx < 0) return [];
  const eq = text.indexOf("=", idx);
  if (eq < 0) return [];
  let j = eq + 1;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (text[j] !== "{") return [];
  let depth = 0;
  for (let k = j; k < text.length; k++) {
    const c = text[k];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(j, k + 1)) as Record<string, unknown>;
          return Object.values(obj).filter(isProfile);
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/** 把一批文件（db.js / *.json / *.html）解析成档案数组，去重、跳过示例卡。 */
async function filesToProfiles(files: File[]): Promise<ParsedProfile[]> {
  const out: ParsedProfile[] = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (!/\.(js|json|html?)$/.test(name)) continue;
    const text = await f.text();
    if (text.includes("window.PROFILES")) {
      out.push(...extractFromJs(text));
    } else if (name.endsWith(".json")) {
      try {
        const o = JSON.parse(text) as unknown;
        if (isProfile(o)) out.push(o);
        else if (Array.isArray(o)) for (const x of o) if (isProfile(x)) out.push(x);
        // index.json（含 roster 无完整档案）直接忽略，完整档案来自 db.js / 单卡 json
      } catch {
        /* 非 JSON 跳过 */
      }
    }
  }
  const seen = new Set<string>();
  const dedup: ParsedProfile[] = [];
  for (const p of out) {
    if (p.id === "demo_template" || String(p.name).startsWith("示例")) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    dedup.push(p);
  }
  return dedup;
}

/** 递归读 DataTransfer 的目录/文件项（拖入整个资料库文件夹）。 */
function readEntry(entry: any): Promise<File[]> {
  return new Promise((resolve) => {
    if (!entry) return resolve([]);
    if (entry.isFile) {
      entry.file((f: File) => resolve([f]), () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all: any[] = [];
      const batch = () =>
        reader.readEntries(async (entries: any[]) => {
          if (!entries.length) {
            const files: File[] = [];
            for (const e of all) files.push(...(await readEntry(e)));
            resolve(files);
            return;
          }
          all.push(...entries);
          batch();
        });
      batch();
    } else resolve([]);
  });
}

export default function LocalImport({
  close,
  onDone,
}: {
  close: () => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<ParsedProfile[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    setError("");
    setParsing(true);
    try {
      const profiles = await filesToProfiles(files);
      if (!profiles.length) {
        setError(
          "没在这些文件里找到档案数据。请确认选择的是 data/db.js、data/profiles/ 下的 *.json，或整个资料库文件夹（index.html 只是展示页，不含数据）。",
        );
        setPreview(null);
      } else {
        setPreview(profiles);
      }
    } catch (e) {
      setError("文件读取失败：" + (e as Error).message);
      setPreview(null);
    } finally {
      setParsing(false);
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const items = Array.from(e.dataTransfer.items);
    const entries = items
      .map((i) => (i as any).webkitGetAsEntry?.())
      .filter(Boolean);
    if (entries.length) {
      const files: File[] = [];
      for (const en of entries) files.push(...(await readEntry(en)));
      await handleFiles(files);
    } else {
      await handleFiles(Array.from(e.dataTransfer.files));
    }
  }

  async function doImport(overwrite: boolean) {
    if (!preview?.length) return;
    setImporting(true);
    setError("");
    try {
      const r = await apiFetch("/api/profile/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profiles: preview, overwrite }),
      });
      const d = (await r.json()) as { imported?: number; skipped?: number; error?: string };
      if (!r.ok) throw new Error(d.error || "导入失败");
      setDone(`成功导入 ${d.imported ?? 0} 份${d.skipped ? `，跳过 ${d.skipped} 份` : ""}`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  if (done) {
    return (
      <div className="overlay">
        <div className="modal">
          <header>
            <h2>导入完成</h2>
            <button className="icon" onClick={close} aria-label="关闭">
              ✕
            </button>
          </header>
          <p className="li-done">
            <CheckCircle2 size={18} /> {done}
          </p>
          <button className="primary" onClick={close}>
            完成
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay">
      <div className="modal li-modal">
        <header>
          <h2>导入本地资料库</h2>
          <button className="icon" onClick={close} aria-label="关闭">
            ✕
          </button>
        </header>

        <p className="li-desc">
          旧版「本地页面 + 数据库」用户直接拖入资料库文件夹（或
          <code> data/db.js </code>、<code>data/profiles/*.json</code>），一键把对象档案搬到云端，不用再二次录入。
        </p>

        <div
          className="li-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          <Upload size={22} />
          <div>
            <b>拖入文件夹 / 文件到这里</b>
            <span>或点下面按钮选择</span>
          </div>
        </div>

        <div className="li-actions">
          <button className="secondary" onClick={() => fileRef.current?.click()}>
            <FileJson size={15} /> 选择 db.js / json
          </button>
          <button className="secondary" onClick={() => dirRef.current?.click()}>
            <FolderOpen size={15} /> 选择整个资料库文件夹
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".js,.json,.html,.htm"
          style={{ display: "none" }}
          onChange={(e) => {
            void handleFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <input
          ref={dirRef}
          type="file"
          // @ts-expect-error webkitdirectory 是 Chrome/Edge 专有属性
          webkitdirectory=""
          style={{ display: "none" }}
          onChange={(e) => {
            void handleFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />

        {parsing && (
          <p className="li-parsing">
            <Loader2 size={15} className="spin" /> 正在解析文件…
          </p>
        )}
        {error && <p className="error">{error}</p>}

        {preview && (
          <div className="li-preview">
            <p className="li-count">
              识别到 <b>{preview.length}</b> 份档案
            </p>
            <ul>
              {preview.slice(0, 60).map((p) => (
                <li key={p.id}>
                  <span className="li-pname">{p.name}</span>
                  <span className="li-pmeta">
                    {p.platform ?? "?"} · {p.verdict ?? "—"} · {p.interest ?? "?"}分
                  </span>
                </li>
              ))}
              {preview.length > 60 && <li className="li-more">… 其余 {preview.length - 60} 份</li>}
            </ul>
            <button
              className="primary"
              disabled={importing}
              onClick={() => doImport(false)}
            >
              {importing ? "导入中…" : `导入 ${preview.length} 份档案`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

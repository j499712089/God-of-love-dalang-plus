import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  Brain,
  Camera,
  CircleHelp,
  IdCard,
  ImageUp,
  Loader2,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { apiFetch } from "./api";
import type {
  AnalysisImage,
  DeepAnalysis,
  ExtractedProfile,
  InferenceItem,
  OpenerPlan,
  PhotoObservation,
} from "../shared/types";

/** /api/profile/dup-check 返回的候选（与 server/profile.ts ProfileMatchCandidate 一致） */
type MatchCandidate = {
  id: string;
  name: string;
  platform: string;
  verdict: string;
  score: number;
  reasons: string[];
};

/** 与 server/index.ts 的 PLATFORM_SLUGS 保持一致 */
const PLATFORMS: { label: string; slug: string }[] = [
  { label: "抖音", slug: "douyin" },
  { label: "探探", slug: "tantan" },
  { label: "牵手", slug: "qianshou" },
  { label: "积目", slug: "jimu" },
  { label: "SOUL", slug: "soul" },
  { label: "小红书", slug: "xhs" },
  { label: "微博", slug: "weibo" },
  { label: "微信", slug: "wechat" },
  { label: "其他", slug: "other" },
];

const IMG_TYPES = /^image\/(jpeg|png|webp)$/;
const IMG_MAX_EDGE = 1536; // 资料页文字多，压缩上限放宽一点保住可读性

const CONFIDENCE_OPTIONS = ["高", "中", "低", "信息不足"];
const emptyInference = (): InferenceItem => ({
  title: "",
  confidence: "中",
  evidence: "",
  readings: [],
  means: "",
});

let seq = 0;
async function fileToImage(file: File): Promise<AnalysisImage | null> {
  if (!IMG_TYPES.test(file.type) || file.size > 12 * 1024 * 1024) return null;
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("图片读取失败"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("图片解码失败"));
    im.src = raw;
  });
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  let out = raw;
  if (ctx) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    out = canvas.toDataURL("image/jpeg", 0.85);
  }
  seq += 1;
  return {
    id: `pimg_${Date.now().toString(36)}_${seq}`,
    name: file.name || `资料图${seq}`,
    dataUrl: out,
  };
}

type Props = {
  /** 当前窗口已绑定的资料卡：有则提供「更新到这张卡」选项 */
  boundProfile: { id: string; name: string } | null;
  close: () => void;
  /** 保存成功回调：mode=new/match 时 App 侧会自动绑定到当前窗口 */
  onSaved: (id: string, name: string, mode: "new" | "bound" | "match") => void;
};

export default function ProfileImport({ boundProfile, close, onSaved }: Props) {
  const [platform, setPlatform] = useState("抖音");
  const [images, setImages] = useState<AnalysisImage[]>([]);
  // 🔴 身份说明（2026-10-01 主人定板）：公域和微信的名字可能不一样但是同一个人，
  // 不说明清楚 AI 会建错卡/更错卡。这段文字随图一起传给模型，并落库到资料卡 summary。
  const [aliasNote, setAliasNote] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedProfile | null>(null);
  const [saving, setSaving] = useState(false);
  // 有绑定卡 → 默认「更新到绑定卡」（主人要求：更新资料进去就自动更对应人的卡）
  const [saveMode, setSaveMode] = useState<"new" | "bound" | "match">(
    boundProfile ? "bound" : "new",
  );
  // 跨平台查重（2026-09-24）：同一个女生在牵手/微信等多平台，建档前先查档案库
  const [matches, setMatches] = useState<MatchCandidate[]>([]);
  const [checking, setChecking] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 公域开场白（§5 开场分流：有通道=Hi / 无通道高搭话=一句话开场）
  const [openerChannel, setOpenerChannel] = useState<"matched" | "cold">("matched");
  const [opener, setOpener] = useState<OpenerPlan | null>(null);
  const [generatingOpener, setGeneratingOpener] = useState(false);

  const runDupCheck = useCallback(
    async (data: ExtractedProfile) => {
      setChecking(true);
      try {
        const r = await apiFetch("/api/profile/dup-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nickname: data.nickname,
            age: data.age,
            city: data.city,
            occupation: data.occupation,
            interests: data.interests,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "查重失败");
        const list = (d.matches ?? []) as MatchCandidate[];
        // 当前窗口已绑定的卡单列「更新到绑定卡」选项，不在候选里重复出现
        const filtered = boundProfile
          ? list.filter((m) => m.id !== boundProfile.id)
          : list;
        setMatches(filtered);
        // 强匹配（≥0.5，即至少昵称相同）自动选中合并模式
        if (filtered.length && filtered[0].score >= 0.5) {
          setMatchId(filtered[0].id);
          setSaveMode((prev) => (prev === "bound" ? prev : "match"));
        } else {
          setMatchId(null);
          setSaveMode((prev) =>
            prev === "match" ? (boundProfile ? "bound" : "new") : prev,
          );
        }
      } catch {
        setMatches([]); // 查重失败不阻塞建档
        setMatchId(null);
        setSaveMode((prev) =>
          prev === "match" ? (boundProfile ? "bound" : "new") : prev,
        );
      } finally {
        setChecking(false);
      }
    },
    [boundProfile],
  );

  // 识别出结果后自动查重；用户修正昵称/年龄/城市后 600ms 防抖重查
  useEffect(() => {
    if (!extracted) return;
    const t = setTimeout(() => void runDupCheck(extracted), 600);
    return () => clearTimeout(t);
  }, [
    extracted,
    extracted?.nickname,
    extracted?.age,
    extracted?.city,
    extracted?.occupation,
    extracted?.interests,
    runDupCheck,
  ]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => IMG_TYPES.test(f.type));
    if (!list.length) {
      setNotice("只支持 jpg / png / webp 图片");
      return;
    }
    const out: AnalysisImage[] = [];
    for (const f of list) {
      try {
        const img = await fileToImage(f);
        if (img) out.push(img);
      } catch {
        setNotice(`「${f.name}」处理失败，已跳过`);
      }
    }
    if (!out.length) return;
    setImages((prev) => [...prev, ...out]); // 张数不限（2026-09-24）：服务端自动分批识别
    setNotice("");
  }, []);

  const removeImage = (id: string) =>
    setImages((prev) => prev.filter((x) => x.id !== id));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  };

  async function extract() {
    if (!images.length || extracting) return;
    setExtracting(true);
    setNotice("");
    try {
      const r = await apiFetch("/api/vision/profile-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: images.map(({ id, name, dataUrl }) => ({ id, name, dataUrl })),
          platform,
          // 身份说明（微信名 vs 公域名对照等）随图传给模型，防 AI 认错人/更错卡
          note: aliasNote.trim(),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 非 JSON 响应（如网关 502/504 HTML）也要带出状态码，禁止只显示模糊兜底
        throw new Error(
          r.status === 413
            ? "图片总体积太大，请删掉几张再试（服务端单次请求上限 32MB）"
            : (d as { error?: string }).error || `资料识别失败（HTTP ${r.status}）`,
        );
      }
      const p = d as ExtractedProfile;
      setExtracted({
        platform: p.platform || platform,
        nickname: p.nickname || "",
        age: p.age || "",
        city: p.city || "",
        occupation: p.occupation || "",
        income: p.income || "",
        bio: p.bio || "",
        interests: p.interests || [],
        photosSummary: p.photosSummary || "",
        authenticity: p.authenticity || "",
        redFlags: p.redFlags || [],
        notes: p.notes || "",
        facts: p.facts || [],
        photoObservations: p.photoObservations || [],
        deep: p.deep ?? null,
      });
      if (boundProfile) setSaveMode("bound");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }

  const editField = (key: keyof ExtractedProfile, value: string) =>
    setExtracted((prev) => (prev ? { ...prev, [key]: value } : prev));

  /** 生成公域开场白：基于已识别资料 + 通道类型（§5 开场分流）。 */
  async function genOpener() {
    if (!extracted || generatingOpener) return;
    setGeneratingOpener(true);
    setNotice("");
    try {
      const r = await apiFetch("/api/vision/opener", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: extracted, channel: openerChannel }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          (d as { error?: string }).error || `开场白生成失败（HTTP ${r.status}）`,
        );
      setOpener(d as OpenerPlan);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setGeneratingOpener(false);
    }
  }

  // ---------- 深层分析编辑器（照片深读 / 没说的推断 / 待确认 / 机会风险） ----------
  const setDeep = (patch: Partial<DeepAnalysis>) =>
    setExtracted((prev) =>
      prev
        ? {
            ...prev,
            deep: {
              dressPsychology: "",
              personaRead: "",
              truthNote: "",
              truthCheck: [],
              inferences: [],
              gaps: [],
              chance: [],
              risk: [],
              ...prev.deep,
              ...patch,
            },
          }
        : prev,
    );

  const setObs = (no: number, patch: Partial<PhotoObservation>) =>
    setExtracted((prev) =>
      prev
        ? {
            ...prev,
            photoObservations: prev.photoObservations.map((o) =>
              o.no === no ? { ...o, ...patch } : o,
            ),
          }
        : prev,
    );

  const removeObs = (no: number) =>
    setExtracted((prev) =>
      prev ? { ...prev, photoObservations: prev.photoObservations.filter((o) => o.no !== no) } : prev,
    );

  const addObs = () =>
    setExtracted((prev) => {
      if (!prev) return prev;
      const no = prev.photoObservations.reduce((m, o) => Math.max(m, o.no), 0) + 1;
      return {
        ...prev,
        photoObservations: [
          ...prev.photoObservations,
          { no, kind: "生活照", content: "", dress: "", scene: "", pose: "", decode: "" },
        ],
      };
    });

  const setInf = (idx: number, patch: Partial<InferenceItem>) =>
    setExtracted((prev) => {
      if (!prev?.deep) return prev;
      return {
        ...prev,
        deep: {
          ...prev.deep,
          inferences: prev.deep.inferences.map((it, i) =>
            i === idx ? { ...it, ...patch } : it,
          ),
        },
      };
    });

  const removeInf = (idx: number) =>
    setExtracted((prev) =>
      prev?.deep
        ? {
            ...prev,
            deep: {
              ...prev.deep,
              inferences: prev.deep.inferences.filter((_, i) => i !== idx),
            },
          }
        : prev,
    );

  const addInf = () =>
    setExtracted((prev) =>
      prev?.deep
        ? { ...prev, deep: { ...prev.deep, inferences: [...prev.deep.inferences, emptyInference()] } }
        : prev,
    );

  /** 可编辑标签列表（待确认 / 机会 / 风险共用） */
  const chipList = (
    label: string,
    icon: ReactNode,
    items: string[],
    onChange: (next: string[]) => void,
    placeholder: string,
  ) => (
    <div className="pi-chips">
      <h4 className="pi-sec-title">
        {icon} {label}
      </h4>
      <div className="pi-tags">
        {items.map((t) => (
          <span key={t} className="ii-tag pi-tag-editable">
            {t}
            <button aria-label={`删除 ${t}`} onClick={() => onChange(items.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="pi-tag-input"
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = e.currentTarget.value.trim();
              if (v && !items.includes(v)) onChange([...items, v]);
              e.currentTarget.value = "";
            }
          }}
        />
      </div>
    </div>
  );

  async function save() {
    if (!extracted || saving) return;
    const mode = saveMode;
    const matchCand = matches.find((m) => m.id === matchId) ?? null;
    const name = extracted.nickname.trim() || matchCand?.name || boundProfile?.name || "";
    if (mode === "new" && !extracted.nickname.trim()) {
      setNotice("昵称是空的：请在上方填一个昵称（建档必须有名字）");
      return;
    }
    if (mode === "match" && !matchCand) {
      setNotice("请先在「档案库查重」里选择要合并的档案");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      let id: string;
      if (mode === "new") {
        const slug =
          PLATFORMS.find((p) => p.label === (extracted.platform || platform))?.slug ??
          "other";
        const newId = `u${Date.now().toString(36)}_${slug}`;
        const r = await apiFetch("/api/profile/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: newId,
            name: extracted.nickname.trim(),
            platform: extracted.platform || platform,
            verdict: "观察中",
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "建档失败");
        id = d.id ?? newId;
      } else if (mode === "bound") {
        if (!boundProfile) throw new Error("当前窗口未绑定资料卡");
        id = boundProfile.id;
      } else {
        id = matchCand!.id;
      }
      const targetName =
        mode === "new"
          ? extracted.nickname.trim()
          : mode === "bound"
            ? boundProfile?.name ?? name
            : matchCand!.name;
      // 读现有档案 → 合并 facts / summary / photos（不覆盖已有内容）
      let existing: Record<string, unknown> = {};
      try {
        const r = await apiFetch(`/api/profile/${id}`);
        if (r.ok) existing = await r.json();
      } catch {
        /* 读不到就当空档案 */
      }
      // 🔴 CLI 模板里 facts 是对象（键值表）；兼容历史数组格式并归一化，避免合并时丢已有数据
      const factObj: Record<string, string> = {};
      const srcFacts: unknown = existing.facts;
      if (Array.isArray(srcFacts)) {
        for (const f of srcFacts as { item?: string; value?: string }[]) {
          if (f?.item) factObj[f.item] = String(f.value ?? "");
        }
      } else if (srcFacts && typeof srcFacts === "object") {
        for (const [k, v] of Object.entries(srcFacts as Record<string, unknown>)) {
          factObj[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
      }
      const srcPlatform = extracted.platform || platform;
      const addFact = (item: string, value?: string) => {
        const v = value?.trim();
        if (!v) return;
        if (!factObj[item]) factObj[item] = v;
        else if (factObj[item] !== v)
          factObj[`${item}·${srcPlatform}`] = v; // 同键不同值（跨平台口径不一）都保留
      };
      // 平台特殊处理：跨平台合并时聚合成「牵手、微信」，不拆成多条
      if (srcPlatform) {
        const prev = factObj["平台"]?.trim();
        if (!prev) factObj["平台"] = srcPlatform;
        else if (!prev.split(/[、,，]/).includes(srcPlatform))
          factObj["平台"] = `${prev}、${srcPlatform}`;
      }
      addFact("年龄", extracted.age);
      addFact("城市", extracted.city);
      addFact("职业", extracted.occupation);
      addFact("收入线索", extracted.income);
      if (extracted.interests.length)
        addFact("兴趣", extracted.interests.join("、"));
      for (const f of extracted.facts) addFact(f.item, f.value);
      const deep = extracted.deep;
      const summaryParts = [
        typeof existing.summary === "string" ? existing.summary : "",
        aliasNote.trim() ? `身份说明（主人填写）：${aliasNote.trim()}` : "",
        extracted.bio?.trim() ? `简介：${extracted.bio.trim()}` : "",
        extracted.photosSummary?.trim()
          ? `照片印象：${extracted.photosSummary.trim()}`
          : "",
        deep?.dressPsychology?.trim() ? `穿搭心理：${deep.dressPsychology.trim()}` : "",
        deep?.personaRead?.trim() ? `人设经营：${deep.personaRead.trim()}` : "",
        extracted.notes?.trim() ? `AI 备注：${extracted.notes.trim()}` : "",
        extracted.redFlags.length
          ? `风险提示：${extracted.redFlags.join("；")}`
          : "",
      ].filter(Boolean);
      const patch: Record<string, unknown> = { facts: factObj };
      if (summaryParts.length) patch.summary = summaryParts.join("\n");
      // 照片深读：逐张落库（content = 客观画面，decode = 穿搭 + 深解读），没有逐张数据时退回整体印象
      if (extracted.photoObservations.length) {
        const photos = Array.isArray(existing.photos)
          ? [...(existing.photos as Record<string, unknown>[])]
          : [];
        for (const o of extracted.photoObservations) {
          const content = [
            o.kind ? `【${o.kind}】` : "",
            o.content,
            o.scene ? `场景：${o.scene}` : "",
            o.pose ? `姿态：${o.pose}` : "",
          ]
            .filter(Boolean)
            .join(" ")
            .trim();
          const decode = [o.dress ? `穿搭：${o.dress}` : "", o.decode]
            .filter(Boolean)
            .join("；")
            .trim();
          if (content || decode)
            photos.push({ n: photos.length + 1, content: content || "资料截图", decode });
        }
        if (photos.length) patch.photos = photos;
      } else if (extracted.photosSummary?.trim() || extracted.authenticity?.trim()) {
        const photos = Array.isArray(existing.photos)
          ? [...(existing.photos as Record<string, unknown>[])]
          : [];
        photos.push({
          n: photos.length + 1,
          content: extracted.photosSummary?.trim() || "资料截图",
          decode: extracted.authenticity?.trim() || "",
        });
        patch.photos = photos;
      }
      // ---------- 深层分析落库（对齐模板字段） ----------
      if (deep) {
        // 真实性五维：按 dim 合并（新读数覆盖同名维度）
        if (deep.truthCheck.length) {
          const tc = Array.isArray(existing.truth_check)
            ? [...(existing.truth_check as Record<string, unknown>[])]
            : [];
          for (const t of deep.truthCheck) {
            const i = tc.findIndex(
              (x) => (x as { dim?: string })?.dim === t.dim,
            );
            if (i >= 0) tc[i] = t;
            else tc.push(t);
          }
          patch.truth_check = tc.slice(0, 6);
        }
        if (deep.truthNote.trim()) {
          const prevNote =
            typeof existing.truth_note === "string" ? existing.truth_note.trim() : "";
          patch.truth_note = prevNote
            ? `${prevNote}；${deep.truthNote.trim()}`
            : deep.truthNote.trim();
        }
        // 深层推断：按 title 去重追加
        if (deep.inferences.length) {
          const inf = Array.isArray(existing.inferences)
            ? [...(existing.inferences as Record<string, unknown>[])]
            : [];
          const titles = new Set(
            inf.map((x) => String((x as { title?: string })?.title ?? "")),
          );
          for (const it of deep.inferences) {
            if (it.title.trim() && !titles.has(it.title.trim())) {
              inf.push(it);
              titles.add(it.title.trim());
            }
          }
          if (inf.length) patch.inferences = inf.slice(0, 12);
        }
        // 待确认变量：追加去重
        if (deep.gaps.length) {
          const gaps = Array.isArray(existing.gaps)
            ? (existing.gaps as unknown[]).map(String)
            : [];
          for (const g of deep.gaps) if (g.trim() && !gaps.includes(g)) gaps.push(g);
          if (gaps.length) patch.gaps = gaps.slice(0, 15);
        }
        // 机会 / 风险：合并去重
        if (deep.chance.length || deep.risk.length) {
          const pos = (
            existing.position && typeof existing.position === "object"
              ? existing.position
              : {}
          ) as { chance?: unknown; risk?: unknown };
          const chance = Array.isArray(pos.chance) ? pos.chance.map(String) : [];
          const risk = Array.isArray(pos.risk) ? pos.risk.map(String) : [];
          for (const c of deep.chance) if (c.trim() && !chance.includes(c)) chance.push(c);
          for (const r of deep.risk) if (r.trim() && !risk.includes(r)) risk.push(r);
          patch.position = { chance: chance.slice(0, 8), risk: risk.slice(0, 8) };
        }
      }
      const r2 = await apiFetch(`/api/profile/${id}/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r2.ok) {
        const d2 = await r2.json().catch(() => ({}));
        throw new Error(d2.error || "写入资料卡失败");
      }
      onSaved(id, targetName, mode);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="profile-import">
      {/* 第一步：平台 + 拖拽上传 */}
      <div className="pi-step">
        <div className="pi-row">
          <label className="field">
            资料来自哪个平台
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              disabled={extracting}
            >
              {PLATFORMS.map((p) => (
                <option value={p.label} key={p.slug}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <p className="pi-hint">
            录入她的<b>朋友圈 / 公域资料</b>（资料页 / 相册 / 动态截图）拖进来，AI
            读取后<b>自动更新她绑定的资料卡</b>（当前窗口：{boundProfile ? `「${boundProfile.name}」` : "未绑定，保存时可选建档"}）。读不到的信息不会编造，识别后仍可逐项修改。
          </p>
        </div>
        <label className="field pi-alias">
          身份说明（公域名 ≠ 微信名时必填，防止更错卡）
          <textarea
            className="pi-ta-sm"
            value={aliasNote}
            onChange={(e) => setAliasNote(e.target.value)}
            placeholder="例：她在抖音叫「小鹿不迷路」，微信备注是「陈大米May」，是同一个人。朋友圈内容和微信聊天是同一人。"
            disabled={extracting}
          />
        </label>
        <div
          className={`pi-drop ${dragOver ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => !extracting && fileRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
        >
          <ImageUp size={22} />
          <p>拖入资料截图到这里，或点击选择图片（数量不限，AI 自动分批读取）</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {images.length > 0 && (
          <div className="img-strip">
            {images.map((img) => (
              <figure key={img.id} className="img-thumb">
                <img src={img.dataUrl} alt={img.name || "资料截图"} />
                <button
                  className="img-remove"
                  aria-label={`删除 ${img.name || "图片"}`}
                  onClick={() => removeImage(img.id)}
                >
                  <X size={12} />
                </button>
              </figure>
            ))}
          </div>
        )}
        <div className="pi-actions">
          <button
            className="primary"
            disabled={!images.length || extracting}
            onClick={() => void extract()}
          >
            {extracting ? (
              <>
                <Loader2 size={15} className="spin" /> AI 正在读取资料…
              </>
            ) : (
              <>
                <Sparkles size={15} /> AI 识别资料
              </>
            )}
          </button>
        </div>
      </div>

      {notice && <p className="error">{notice}</p>}

      {/* 第二步：识别结果表单（可编辑） */}
      {extracted && (
        <div className="pi-step pi-result">
          <h3 className="pi-result-title">
            <IdCard size={16} /> 识别结果（确认或修改后再保存）
          </h3>
          <div className="pi-grid">
            <label className="field">
              昵称 *
              <input
                value={extracted.nickname}
                onChange={(e) => editField("nickname", e.target.value)}
                placeholder="建档必须有名字"
              />
            </label>
            <label className="field">
              年龄
              <input
                value={extracted.age}
                onChange={(e) => editField("age", e.target.value)}
              />
            </label>
            <label className="field">
              城市
              <input
                value={extracted.city}
                onChange={(e) => editField("city", e.target.value)}
              />
            </label>
            <label className="field">
              职业
              <input
                value={extracted.occupation}
                onChange={(e) => editField("occupation", e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            简介（原文）
            <textarea
              className="pi-bio"
              value={extracted.bio}
              onChange={(e) => editField("bio", e.target.value)}
            />
          </label>
          {extracted.interests.length > 0 && (
            <div className="pi-tags">
              {extracted.interests.map((t) => (
                <span key={t} className="ii-tag pi-tag-editable">
                  {t}
                  <button
                    aria-label={`删除标签 ${t}`}
                    onClick={() =>
                      setExtracted((prev) =>
                        prev
                          ? { ...prev, interests: prev.interests.filter((x) => x !== t) }
                          : prev,
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="pi-tag-input"
                placeholder="+ 加标签后回车"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = e.currentTarget.value.trim();
                    if (v && !extracted.interests.includes(v))
                      setExtracted((prev) =>
                        prev ? { ...prev, interests: [...prev.interests, v] } : prev,
                      );
                    e.currentTarget.value = "";
                  }
                }}
              />
            </div>
          )}
          <label className="field">
            照片印象
            <textarea
              value={extracted.photosSummary}
              onChange={(e) => editField("photosSummary", e.target.value)}
            />
          </label>
          <label className="field">
            真实性评估
            <input
              value={extracted.authenticity}
              onChange={(e) => editField("authenticity", e.target.value)}
            />
          </label>
          {extracted.redFlags.length > 0 && (
            <div className="pi-flags">
              <ShieldAlert size={14} />
              {extracted.redFlags.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </div>
          )}
          <label className="field">
            AI 备注
            <textarea
              value={extracted.notes}
              onChange={(e) => editField("notes", e.target.value)}
            />
          </label>

          {/* ---------- 公域开场白（§5 开场分流） ---------- */}
          <div className="pi-deep-sec">
            <h4 className="pi-sec-title">
              <Sparkles size={14} /> 怎么开场（公域第一句）
            </h4>
            <div className="pi-opener-row">
              <label className="pi-radio">
                <input
                  type="radio"
                  checked={openerChannel === "matched"}
                  onChange={() => setOpenerChannel("matched")}
                />
                已有通道（已匹配 / 已加好友）→ 只发 Hi
              </label>
              <label className="pi-radio">
                <input
                  type="radio"
                  checked={openerChannel === "cold"}
                  onChange={() => setOpenerChannel("cold")}
                />
                无通道 · 高搭话量（抖音私信 / 评论区）→ 一句话开场
              </label>
            </div>
            <div className="pi-actions">
              <button
                className="primary"
                disabled={generatingOpener}
                onClick={() => void genOpener()}
              >
                {generatingOpener ? (
                  <>
                    <Loader2 size={15} className="spin" /> 生成开场白…
                  </>
                ) : (
                  <>
                    <Sparkles size={15} /> 生成开场白
                  </>
                )}
              </button>
            </div>
            {opener && (
              <div className="pi-opener-card">
                <blockquote className="next-reply">{opener.opener}</blockquote>
                {opener.reason && <p className="pi-opener-reason">{opener.reason}</p>}
                {opener.branches.length > 0 && (
                  <div className="round-branches">
                    {opener.branches.map((b, i) => (
                      <p key={i} className="rb-good">
                        {b.trigger} → {b.move}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ---------- 深层分析：逐张照片深读 ---------- */}
          {extracted.photoObservations.length > 0 && (
            <div className="pi-deep-sec">
              <h4 className="pi-sec-title">
                <Camera size={14} /> 照片深读（逐张客观读图 + 深解读，可修改）
              </h4>
              {extracted.photoObservations.map((o) => (
                <div key={o.no} className="pi-photo-card">
                  <div className="pi-photo-head">
                    <span className="pi-photo-no">第{o.no}张</span>
                    <input
                      className="pi-photo-kind"
                      value={o.kind}
                      placeholder="类型（资料页/生活照/自拍…）"
                      onChange={(e) => setObs(o.no, { kind: e.target.value })}
                    />
                    <button
                      className="pi-del"
                      aria-label={`删除第${o.no}张读图`}
                      onClick={() => removeObs(o.no)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <div className="pi-photo-grid">
                    <input
                      value={o.dress}
                      placeholder="穿搭细节"
                      onChange={(e) => setObs(o.no, { dress: e.target.value })}
                    />
                    <input
                      value={o.scene}
                      placeholder="场景"
                      onChange={(e) => setObs(o.no, { scene: e.target.value })}
                    />
                    <input
                      value={o.pose}
                      placeholder="姿态表情"
                      onChange={(e) => setObs(o.no, { pose: e.target.value })}
                    />
                  </div>
                  <textarea
                    className="pi-ta-sm"
                    value={o.content}
                    placeholder="画面要点（内容/图上文字/细节信号）"
                    onChange={(e) => setObs(o.no, { content: e.target.value })}
                  />
                  <textarea
                    className="pi-ta-sm"
                    value={o.decode}
                    placeholder="深解读：这张照片在传达什么/经营什么（AI 深层分析后填入）"
                    onChange={(e) => setObs(o.no, { decode: e.target.value })}
                  />
                </div>
              ))}
              <button className="pi-add" onClick={addObs}>
                + 补一条读图
              </button>
            </div>
          )}

          {/* ---------- 深层分析：她没说的（四件套推断） ---------- */}
          {extracted.deep && (
            <div className="pi-deep-sec">
              <h4 className="pi-sec-title">
                <Brain size={14} /> 深层推断 · 她没说的（每条带证据 + 双视角解读）
              </h4>
              {extracted.deep.inferences.map((it, idx) => (
                <div key={idx} className="pi-inf-card">
                  <div className="pi-photo-head">
                    <input
                      className="pi-photo-kind"
                      value={it.title}
                      placeholder="推断标题（如 收入自述存疑）"
                      onChange={(e) => setInf(idx, { title: e.target.value })}
                    />
                    <select
                      value={it.confidence}
                      onChange={(e) => setInf(idx, { confidence: e.target.value })}
                    >
                      {CONFIDENCE_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <button
                      className="pi-del"
                      aria-label={`删除推断 ${it.title || idx + 1}`}
                      onClick={() => removeInf(idx)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <textarea
                    className="pi-ta-sm"
                    value={it.evidence}
                    placeholder="证据（引用照片序号或字段）"
                    onChange={(e) => setInf(idx, { evidence: e.target.value })}
                  />
                  <textarea
                    className="pi-ta-sm"
                    value={it.readings.join("\n")}
                    placeholder="两种解读（每行一条：善意解释 / 警惕视角）"
                    onChange={(e) =>
                      setInf(idx, {
                        readings: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                      })
                    }
                  />
                  <input
                    value={it.means}
                    placeholder="应对：这条推断对推进意味着什么"
                    onChange={(e) => setInf(idx, { means: e.target.value })}
                  />
                </div>
              ))}
              <button className="pi-add" onClick={addInf}>
                + 补一条推断
              </button>
            </div>
          )}

          {extracted.deep && (
            <div className="pi-deep-sec">
              <label className="field">
                穿搭心理（审美取向 / 自我呈现策略 / 消费暗示 / 性格投射）
                <textarea
                  value={extracted.deep.dressPsychology}
                  onChange={(e) => setDeep({ dressPsychology: e.target.value })}
                />
              </label>
              <label className="field">
                人设经营（资料想让你看到什么 / 刻意回避什么）
                <textarea
                  value={extracted.deep.personaRead}
                  onChange={(e) => setDeep({ personaRead: e.target.value })}
                />
              </label>
              <label className="field">
                真实性总结
                <textarea
                  className="pi-ta-sm"
                  value={extracted.deep.truthNote}
                  onChange={(e) => setDeep({ truthNote: e.target.value })}
                />
              </label>
              {extracted.deep.truthCheck.length > 0 && (
                <div className="pi-truth5">
                  {extracted.deep.truthCheck.map((t) => (
                    <span key={t.dim} className="pi-dim">
                      <b>{t.dim}</b>
                      {t.result}
                      <i className={`pi-lv lv-${t.level}`}>{t.level}</i>
                    </span>
                  ))}
                </div>
              )}
              {chipList(
                "待确认变量",
                <CircleHelp size={14} />,
                extracted.deep.gaps,
                (next) => setDeep({ gaps: next }),
                "+ 缺什么信息？回车添加",
              )}
              <div className="pi-two-col">
                {chipList(
                  "机会点",
                  <TrendingUp size={14} />,
                  extracted.deep.chance,
                  (next) => setDeep({ chance: next }),
                  "+ 机会点",
                )}
                {chipList(
                  "风险点",
                  <TrendingDown size={14} />,
                  extracted.deep.risk,
                  (next) => setDeep({ risk: next }),
                  "+ 风险点",
                )}
              </div>
            </div>
          )}

          <div className="pi-save-mode">
            {/* 查重结果：档案库里可能已有同一人（跨平台合并） */}
            <div className="pi-match">
              <h4 className="pi-match-title">
                <Search size={13} /> 档案库查重
              </h4>
              {checking ? (
                <p className="pi-match-hint">
                  <Loader2 size={12} className="spin" /> 正在比对档案库…
                </p>
              ) : matches.length === 0 ? (
                <p className="pi-match-hint">
                  档案库里没有疑似同一人，可直接新建档案。
                </p>
              ) : (
                <>
                  <p className="pi-match-hint warn">
                    档案库里已有疑似同一人 —— 同一个女生跨平台（如牵手→微信）建议合并进同一张卡：
                  </p>
                  <div className="pi-match-list">
                    {matches.map((m) => (
                      <label
                        key={m.id}
                        className={`pi-match-item ${saveMode === "match" && matchId === m.id ? "sel" : ""}`}
                      >
                        <input
                          type="radio"
                          name="pi-match-cand"
                          checked={saveMode === "match" && matchId === m.id}
                          onChange={() => {
                            setMatchId(m.id);
                            setSaveMode("match");
                          }}
                        />
                        <span className="pm-name">「{m.name}」</span>
                        <span className="pm-meta">
                          {m.platform}
                          {m.verdict ? ` · ${m.verdict}` : ""} · 匹配{" "}
                          {Math.round(m.score * 100)}%
                        </span>
                        {m.reasons.length > 0 && (
                          <span className="pm-reasons">{m.reasons.join("、")}</span>
                        )}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
            <label className="pi-radio">
              <input
                type="radio"
                checked={saveMode === "new"}
                onChange={() => setSaveMode("new")}
              />
              存为新档案{extracted.nickname.trim() ? `「${extracted.nickname.trim()}」` : ""}
            </label>
            {boundProfile && (
              <label className="pi-radio">
                <input
                  type="radio"
                  checked={saveMode === "bound"}
                  onChange={() => setSaveMode("bound")}
                />
                更新到当前窗口绑定的「{boundProfile.name}」
              </label>
            )}
          </div>
          <div className="pi-actions">
            <button
              className="primary"
              disabled={saving || (saveMode === "new" && !extracted.nickname.trim())}
              onClick={() => void save()}
            >
              {saving ? (
                <>
                  <Loader2 size={15} className="spin" /> 保存中…
                </>
              ) : (
                <>
                  <IdCard size={15} />
                  {saveMode === "new"
                    ? "保存为新档案并绑定本窗口"
                    : saveMode === "bound"
                      ? `更新到「${boundProfile?.name}」`
                      : (matches.find((m) => m.id === matchId)
                          ? `合并到「${matches.find((m) => m.id === matchId)!.name}」（${matches.find((m) => m.id === matchId)!.platform}）`
                          : "合并到已有档案")}
                </>
              )}
            </button>
            <button className="secondary" onClick={close} disabled={saving}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

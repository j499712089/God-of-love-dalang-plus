import { createHash } from "node:crypto";
import type {
  AnalysisImage,
  DeepAnalysis,
  ExtractedProfile,
  InferenceItem,
  OcrChatResult,
  OcrLine,
  OpenerPlan,
  PhotoObservation,
} from "../shared/types";
import { chatCompletion, type ContentPart, type TokenUsage } from "./relay";
import { vectorService } from "./vector";

/** 前端传入的图片（与 /api/analyze 的 images 同构），vision 专用别名。 */
export type VisionImage = Pick<AnalysisImage, "id" | "name" | "dataUrl">;

function visionParts(prompt: string, images: VisionImage[]): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    if (/^data:image\/(jpeg|png|webp);base64,/.test(img.dataUrl))
      parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  return parts;
}

/** 与 analysis.ts 同规则：从模型回复里抠出 JSON（容忍 ```json 围栏）。
 *  用括号配平取第一个完整对象——容忍模型在 JSON 后附加说明文字或第二个对象（实测遇到过）。
 *  报错必须带原始返回片段：否则「解析失败」无法区分是截断、拒答还是空内容。 */
function extractJson(content: string): Record<string, unknown> {
  const trimmed = (content ?? "").trim();
  if (!trimmed)
    throw new Error("模型返回空内容（可能被安全策略拦截或渠道异常，请重试）");
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : trimmed;
  const start = candidate.indexOf("{");
  if (start === -1)
    throw new Error(
      `模型未返回 JSON，返回开头：${candidate.slice(0, 120)}`,
    );
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  // 走到这里 = 有 { 但没配平：输出被截断（max_tokens 或网络中断）
  throw new Error(
    `JSON 不完整（疑似输出被截断），已收到 ${candidate.length} 字符，开头：${candidate.slice(start, start + 120)}`,
  );
}

function str(v: unknown, max = 400): string {
  return typeof v === "string" ? v.slice(0, max).trim() : "";
}

function strArray(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim().slice(0, maxLen) : ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * 资料截图 → 结构化档案。图片 = 同一位女生在某平台的资料页 / 相册 / 动态截图。
 * 只提取图上真实存在的信息，读不到的字段一律空，禁止模型编造。
 * 图片超过单批上限时自动分批调用并合并结果（2026-09-24：资料建档不再限张数）。
 */
const VISION_BATCH = 4; // 上游视觉模型对单请求图片数敏感；astra 单图约 31s，批数减到 4 张防单批超时

async function extractOnce(
  images: VisionImage[],
  platform: string,
  onUsage?: (u: TokenUsage) => void,
  note?: string,
): Promise<ExtractedProfile & { _model: string }> {
  const n = images.length;
  // 🔴 身份说明（2026-10-01）：公域和微信的名字可能不一样但是同一个人，主人手填的
  // 对照说明必须随图进提示词，否则 AI 会把同一人当成两个、更新错资料卡。
  const noteBlock =
    note && note.trim()
      ? `\n\n## 主人填写的身份说明（最高优先级，判断"图里是谁"以此为准）\n${note.trim()}`
      : "";
  const prompt = `你是恋爱分析工作台的资料核验助手。以下 ${n} 张图是同一位女生在社交平台（用户标注：${platform}）的资料截图（可能是资料页、相册、动态、朋友圈）。请逐张读取图片上的文字与画面信息，输出一个 JSON 对象：
{
  "platform": "从图片 UI 推断的平台（抖音/探探/牵手/SOUL/积目/小红书/微博/微信/其他），推断不出就填「未知」",
  "nickname": "她的昵称（图上显示什么就填什么）",
  "age": "年龄（只填数字，如 26）",
  "city": "所在城市",
  "occupation": "职业/行业/公司线索",
  "income": "收入或消费水平线索（如「自述年薪30w」「消费中上」）",
  "bio": "个人简介/签名原文（尽量逐字保留，过长可截断）",
  "interests": ["兴趣标签数组，图上出现的标签或可从内容看出的兴趣，最多8个"],
  "photos_summary": "照片给人的整体印象：穿搭风格、常出现场景、气质、生活状态（2-3句）",
  "authenticity": "真实性评估：从「生活照为主」「精修图为主」「疑似网图」「疑似AI生成」「混合」中选并附一句依据",
  "red_flags": ["资料疑点数组：简介模板化/职业与照片矛盾/引导加微信/挂变现链接/照片与资料页不符等；没有就空数组"],
  "notes": "给后续恋爱分析的综合备注（2-3句：人设印象、择偶信号、需要注意什么）",
  "facts": [{"item": "可核实的具体事实名（如 坐标/身高/学历/星座/平台），短词", "value": "对应的值"}],
  "photo_observations": [
    {
      "kind": "这张图的类型：资料页/生活照/自拍/合影/动态截图/其他",
      "content": "画面要点：画面内容 + 图上可见文字 + 细节信号（随身物品/背景环境/消费线索/生活状态），2-3句",
      "dress": "穿搭细节：风格/颜色/单品/质感（非人物照就写画面主体）",
      "scene": "场景：在哪拍的/什么场合",
      "pose": "姿态与表情：站坐躺拍/看向哪/什么表情"
    }
  ]
}
硬性规则：
- 只填图上真实出现的信息；读不到的字段一律空字符串或空数组，禁止编造、禁止推测填值
- photo_observations 必须逐张输出（按图片给定顺序，一张不落），资料页/动态截图也要有条目（kind=资料页/动态截图）
- 多张图之间信息冲突时，把冲突双方都写进 notes，facts 只放有图面依据的
- facts 每项必须是图上能指认的具体信息，不要放主观评价
- photo_observations 只做客观描述，心理推断交给后续环节，不要写在这里${noteBlock}
- 只输出 JSON，不要输出其他文字`;

  const { content, model } = await chatCompletion(
    [{ role: "user", content: visionParts(prompt, images) }],
    { json: true, vision: true, timeoutMs: 180000, maxTokens: 8000, onUsage },
  );
  const p = extractJson(content);
  const rawFacts = Array.isArray(p.facts) ? p.facts : [];
  const rawObs = Array.isArray(p.photo_observations) ? p.photo_observations : [];
  const observations: PhotoObservation[] = rawObs
    .map((o) => {
      const x = (o ?? {}) as Record<string, unknown>;
      return {
        no: 0, // 全局序号由 mergeExtracted / 调用方统一编号
        kind: str(x.kind, 20),
        content: str(x.content, 600),
        dress: str(x.dress, 200),
        scene: str(x.scene, 200),
        pose: str(x.pose, 200),
        decode: "",
      };
    })
    .filter((o) => o.content || o.dress || o.scene)
    .slice(0, n || 8);
  return {
    platform: str(p.platform, 20) || platform,
    nickname: str(p.nickname, 60),
    age: str(p.age, 10),
    city: str(p.city, 40),
    occupation: str(p.occupation, 120),
    income: str(p.income, 120),
    bio: str(p.bio, 2000),
    interests: strArray(p.interests, 8, 40),
    photosSummary: str(p.photos_summary, 600),
    authenticity: str(p.authenticity, 200),
    redFlags: strArray(p.red_flags, 6, 120),
    notes: str(p.notes, 800),
    facts: rawFacts
      .map((f) => {
        const o = (f ?? {}) as Record<string, unknown>;
        return { item: str(o.item, 40), value: str(o.value, 200) };
      })
      .filter((f) => f.item && f.value)
      .slice(0, 12),
    photoObservations: observations,
    deep: null,
    _model: model,
  };
}

/** 分批结果的合并规则：标量取首个非空；数组去重拼接；文本段拼接去重。 */
function mergeExtracted(
  list: (ExtractedProfile & { _model: string })[],
  platformHint?: string,
): ExtractedProfile & { _model: string } {
  const first = (sel: (x: ExtractedProfile) => string): string => {
    for (const r of list) {
      const v = sel(r).trim();
      if (v) return v;
    }
    return "";
  };
  const dedupe = (arr: string[]): string[] =>
    Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
  const facts: { item: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    for (const f of r.facts) {
      const key = `${f.item}=${f.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(f);
    }
  }
  // 逐张客观读图：跨批连续编号
  const observations: PhotoObservation[] = [];
  for (const r of list) {
    for (const o of r.photoObservations) {
      observations.push({ ...o, no: observations.length + 1 });
    }
  }
  return {
    platform: first((r) => r.platform) || platformHint || "",
    nickname: first((r) => r.nickname),
    age: first((r) => r.age),
    city: first((r) => r.city),
    occupation: first((r) => r.occupation),
    income: first((r) => r.income),
    bio: dedupe(list.map((r) => r.bio)).join("\n").slice(0, 2000),
    interests: dedupe(list.flatMap((r) => r.interests)).slice(0, 12),
    photosSummary: list
      .map((r) => r.photosSummary.trim())
      .filter(Boolean)
      .join("；")
      .slice(0, 600),
    authenticity: first((r) => r.authenticity),
    redFlags: dedupe(list.flatMap((r) => r.redFlags)).slice(0, 10),
    notes: list
      .map((r) => r.notes.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 800),
    facts: facts.slice(0, 24),
    photoObservations: observations,
    deep: null,
    _model: list[0]?._model ?? "",
  };
}

export async function extractProfile(
  images: VisionImage[],
  platformHint?: string,
  onUsage?: (u: TokenUsage) => void,
  note?: string,
): Promise<ExtractedProfile & { _model: string }> {
  const platform =
    platformHint && platformHint.trim() && platformHint !== "其他"
      ? platformHint.trim()
      : "未知（请从图片 UI 推断）";
  // 张数不限：超过一批就分批调视觉模型，逐批提取后合并；单批也要统一编号（no 从 1 起）
  if (images.length <= VISION_BATCH) {
    const single = await extractOnce(images, platform, onUsage, note);
    single.photoObservations.forEach((o, i) => {
      o.no = i + 1;
    });
    return single;
  }
  const chunks: VisionImage[][] = [];
  for (let i = 0; i < images.length; i += VISION_BATCH)
    chunks.push(images.slice(i, i + VISION_BATCH));
  const results: (ExtractedProfile & { _model: string })[] = [];
  for (const chunk of chunks)
    results.push(await extractOnce(chunk, platform, onUsage, note));
  return mergeExtracted(results, platformHint);
}

const TRUTH_LEVELS = ["高", "中-高", "中", "中-低", "低"];
const CONFIDENCES = ["高", "中", "低", "信息不足"];

/**
 * 第二阶段：深层综合分析（主模型 + 向量库方法论命中）。
 * 输入 = 第一阶段客观提取结果；重点产出「她没说的」：深层推断四件套、
 * 真实性五维、穿搭心理、人设经营、待确认变量、机会/风险、逐张照片深解读。
 * 🔴 云端模式下向量库检索是硬门（与大浪分析同纪律）：检索失败直接抛错，不降级为凭模型瞎猜。
 */
export async function synthesizeDeep(
  extracted: ExtractedProfile,
  onUsage?: (u: TokenUsage) => void,
): Promise<DeepAnalysis | null> {
  const hasMaterial =
    extracted.bio.trim() ||
    extracted.notes.trim() ||
    extracted.facts.length ||
    extracted.photoObservations.length;
  if (!hasMaterial) return null;

  // ① 向量库检索大浪方法论（建档核验场景；内容做缓存 key，同资料重试不重复烧配额）
  const query = [
    extracted.occupation,
    extracted.income,
    extracted.bio,
    extracted.interests.join(" "),
    extracted.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 600);
  const girlProfile = [
    extracted.nickname,
    extracted.age ? `${extracted.age}岁` : "",
    extracted.city,
    extracted.occupation,
    extracted.income,
    extracted.bio,
  ]
    .filter(Boolean)
    .join("｜")
    .slice(0, 800);
  let methodology = "";
  if (query || girlProfile) {
    const cacheKey = `pi:${createHash("sha256").update(query + girlProfile).digest("hex").slice(0, 16)}`;
    const retrieved = await vectorService.search(
      {
        query,
        situation: "资料建档核验：从社交平台资料截图读穿搭心理、人设经营、识别资料没写的信号",
        chatLog: "",
        girlProfile,
        userProfile: "",
        cacheKey,
      },
      5,
    );
    const lines: string[] = [];
    const grab = (items: { text?: unknown }[], tag: string) => {
      for (const it of items) {
        const t = String(it.text ?? "").trim();
        if (t) lines.push(`【${tag}】${t.slice(0, 280)}`);
      }
    };
    grab(retrieved.rules, "规则");
    grab(retrieved.strategies, "策略");
    grab(retrieved.cases, "案例");
    methodology = lines.slice(0, 12).join("\n").slice(0, 4000);
  }

  // ② 主模型深层推断
  const inputJson = JSON.stringify(
    {
      平台: extracted.platform,
      昵称: extracted.nickname,
      年龄: extracted.age,
      城市: extracted.city,
      职业: extracted.occupation,
      收入线索: extracted.income,
      简介原文: extracted.bio,
      兴趣: extracted.interests,
      事实: extracted.facts,
      真实性初评: extracted.authenticity,
      资料疑点: extracted.redFlags,
      初步备注: extracted.notes,
      逐张照片客观读图: extracted.photoObservations.map((o) => ({
        photo_no: o.no,
        kind: o.kind,
        content: o.content,
        dress: o.dress,
        scene: o.scene,
        pose: o.pose,
      })),
    },
    null,
    0,
  );
  const prompt = `你是大浪恋爱工作台的深层资料分析器。下面是一位女生的社交平台资料客观提取结果${methodology ? "，以及从大浪方法论库检索到的核验规则与实战案例（分析纪律必须遵循这些内容）" : ""}。

任务：不只复述她写了什么，重点分析「她没说的」——从照片、穿搭、场景、信息缺口做深层推断。

${methodology ? `—— 大浪方法论命中 ——\n${methodology}\n—— 命中结束 —-\n` : ""}
—— 资料客观提取 —-
${inputJson}

输出一个 JSON 对象：
{
  "dress_psychology": "穿搭心理分析（3-5句）：审美取向、自我呈现策略、消费水平暗示、性格投射；必须引用具体照片序号（如 第3张）",
  "persona_read": "人设经营解读（2-4句）：这份资料想让你看到什么、刻意回避什么（如不露脸/无职业信息/只有精修/三天可见）",
  "truth_note": "真实性总结（2-3句）",
  "truth_check": [{"dim": "从头像真实性/照片真实性/资料完整性/职业可核性/社交痕迹一致性 中取", "result": "这一维的核验发现", "level": "高/中-高/中/中-低/低"}],
  "photo_decodes": [{"photo_no": 1, "decode": "这张照片的深解读（2-3句）：在传达什么/经营什么人设/修图与拍摄质感说明什么"}],
  "inferences": [{"title": "推断标题（如 收入自述存疑）", "confidence": "高/中/低/信息不足", "evidence": "具体证据（引用照片序号或字段）", "readings": ["解读A（可含善意解释）", "解读B（警惕视角）"], "means": "应对/这条推断对推进策略意味着什么"}],
  "gaps": ["资料缺失的关键变量（需要用户后续向她确认的）"],
  "chance": ["推进机会点"],
  "risk": ["风险点"]
}
硬性规则：
- inferences 至少 3 条；证据链少于 2 项时 confidence 必须填「信息不足」，readings 仍要给两种方向
- 每条推断必须挂具体证据（引用照片序号或字段名），禁止无证据断言；readings 至少两种不同视角
- 图上没有的信息只能进 inferences（标注为推断）或 gaps，禁止伪装成事实
- truth_check 恰好 5 维；photo_decodes 尽量覆盖每张有人物/场景信息的照片
- 只输出 JSON，不要输出其他文字`;

  const { content } = await chatCompletion(
    [{ role: "user", content: prompt }],
    { json: true, timeoutMs: 180000, maxTokens: 8000, onUsage },
  );
  const p = extractJson(content);

  const truthCheck = (Array.isArray(p.truth_check) ? p.truth_check : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const level = str(o.level, 6);
      return {
        dim: str(o.dim, 20),
        result: str(o.result, 200),
        level: (TRUTH_LEVELS as string[]).includes(level) ? level : "中",
      };
    })
    .filter((x) => x.dim && x.result)
    .slice(0, 6);

  const inferences: InferenceItem[] = (Array.isArray(p.inferences) ? p.inferences : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const conf = str(o.confidence, 6);
      return {
        title: str(o.title, 60),
        confidence: (CONFIDENCES as string[]).includes(conf) ? conf : "中",
        evidence: str(o.evidence, 400),
        readings: strArray(o.readings, 4, 200),
        means: str(o.means, 300),
      };
    })
    .filter((x) => x.title && x.evidence)
    .slice(0, 8);

  // 逐张深解读回填到客观读图条目
  const decodes = Array.isArray(p.photo_decodes) ? p.photo_decodes : [];
  for (const d of decodes) {
    const o = (d ?? {}) as Record<string, unknown>;
    const no = parseInt(String(o.photo_no ?? ""), 10);
    const decode = str(o.decode, 500);
    if (!Number.isNaN(no) && decode) {
      const target = extracted.photoObservations.find((x) => x.no === no);
      if (target) target.decode = decode;
    }
  }

  return {
    dressPsychology: str(p.dress_psychology, 1200),
    personaRead: str(p.persona_read, 800),
    truthNote: str(p.truth_note, 600),
    truthCheck,
    inferences,
    gaps: strArray(p.gaps, 12, 120),
    chance: strArray(p.chance, 6, 120),
    risk: strArray(p.risk, 6, 120),
  };
}

/**
 * 公域开场白（§5 开场分流，不是按平台名而是按「有没有一对一对话通道」）：
 * - channel="matched"：已有通道（双向匹配后 / 已加好友）→ 只发 Hi，不先暴露底牌。
 * - channel="cold"：无通道且对方搭话量极大（抖音私信 / 大V评论区）→ 高搭话量一句话开场。
 * 向量库检索开场方法论 + 主模型基于资料生成开场白 + 反应分支。
 */
export async function generateOpener(
  profile: ExtractedProfile,
  channel: "matched" | "cold",
  onUsage?: (u: TokenUsage) => void,
): Promise<OpenerPlan> {
  const girlProfile = [
    profile.nickname,
    profile.age ? `${profile.age}岁` : "",
    profile.city,
    profile.occupation,
    profile.income,
    profile.bio,
  ]
    .filter(Boolean)
    .join("｜")
    .slice(0, 800);
  const query = [
    profile.occupation,
    profile.bio,
    profile.interests.join(" "),
    profile.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);

  // ① 向量库检索开场方法论
  let methodology = "";
  if (query || girlProfile) {
    const cacheKey = `op:${createHash("sha256").update(`${channel}|${query}|${girlProfile}`).digest("hex").slice(0, 16)}`;
    const retrieved = await vectorService.search(
      {
        query,
        situation: `公域开场：${channel === "matched" ? "已匹配/已加好友，有对话通道" : "无通道高搭话量，需一句话冷启动"}`,
        chatLog: "",
        girlProfile,
        userProfile: "",
        cacheKey,
      },
      5,
    );
    const lines: string[] = [];
    const grab = (items: { text?: unknown }[], tag: string) => {
      for (const it of items) {
        const t = String(it.text ?? "").trim();
        if (t) lines.push(`【${tag}】${t.slice(0, 280)}`);
      }
    };
    grab(retrieved.rules, "规则");
    grab(retrieved.templates, "话术");
    grab(retrieved.cases, "案例");
    methodology = lines.slice(0, 10).join("\n").slice(0, 3500);
  }

  // ② 主模型生成开场白
  const inputJson = JSON.stringify(
    {
      平台: profile.platform,
      昵称: profile.nickname,
      年龄: profile.age,
      城市: profile.city,
      职业: profile.occupation,
      收入线索: profile.income,
      简介原文: profile.bio,
      兴趣: profile.interests,
      资料疑点: profile.redFlags,
      照片整体印象: profile.photosSummary,
    },
    null,
    0,
  );
  const channelRule =
    channel === "matched"
      ? "已有通道（已双向匹配 / 已加好友）：只发 Hi，不先暴露底牌、不做长开场（长开场=先暴露底牌+需求感外泄）。观察对方回复质量判兴趣；冷淡先激发 2-3 次（玩笑/画面/钩子）再止损。开场白就一条「Hi」，重点是给出后面的观察与反应分支。"
      : "无通道且对方搭话量极大（抖音私信 / 大V评论区，消息会被淹没）：高搭话量一句话开场——①先降维破夸赞免疫（好看的真不少）→②再给非外貌的稀缺感（你这样看着舒服的不多）→③给个打招呼的理由（所以打个招呼）→④以退为进测兴趣（不知道你会不会回）。一条话术里完成这四步，重点是够短、够特别、不被淹没。";
  const prompt = `你是大浪恋爱工作台的公域开场指导。下面是一位女生在社交平台（${profile.platform || "未知平台"}）的资料，以及从大浪方法论库检索到的开场规则与案例。

任务：针对「${channel === "matched" ? "已有对话通道" : "无通道高搭话量"}」这个场景，给出一条可直接复制的开场白，并说清为什么、以及对方不同反应的接法。

—— 开场场景铁律 ——
${channelRule}

${methodology ? `—— 大浪方法论命中 ——\n${methodology}\n—— 命中结束 —-\n` : ""}
—— 她的资料 ——
${inputJson}

输出一个 JSON 对象：
{
  "opener": "开场白（可直接复制；matched 场景就一条 Hi，cold 场景是一句话四步）",
  "reason": "为什么这么开场（2-4句：依据她的资料哪一点 + 遵循哪条开场铁律）",
  "branches": [{"trigger": "她这样回", "move": "我这样接"}]
}
硬性规则：
- 开场白必须贴合她的资料（兴趣/简介/照片印象里能抓的点），禁止无差别模板
- matched 场景不得写长开场，cold 场景不得只发 Hi
- branches 给 2-4 条，每条 trigger 是她的一种具体回复，move 是下一步
- 只输出 JSON，不要输出其他文字`;

  const { content } = await chatCompletion(
    [{ role: "user", content: prompt }],
    { json: true, timeoutMs: 120000, maxTokens: 2000, onUsage },
  );
  const p = extractJson(content);

  return {
    channel,
    opener: str(p.opener, 400),
    reason: str(p.reason, 500),
    branches: (Array.isArray(p.branches) ? p.branches : [])
      .map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return {
          trigger: str(o.trigger, 120),
          move: str(o.move, 200),
        };
      })
      .filter((b) => b.trigger && b.move)
      .slice(0, 4),
  };
}

/**
 * 聊天截图 → 对话行。微信等 IM 截图：右侧气泡 = 机主，左侧 = 对方。
 * 只负责逐字转录 + 标注气泡侧别 + 描述图片内容，谁是谁由用户在确认界面拍板。
 * 也支持「图片文件本身」：识别图片里拍的是什么、图上写了什么字，并尽量推断是谁发的。
 */
export async function ocrChat(
  images: VisionImage[],
  onUsage?: (u: TokenUsage) => void,
): Promise<OcrChatResult & { _model: string }> {
  const n = images.length;
  const prompt = `你是聊天记录转录助手。以下 ${n} 张图可能是：①微信/QQ 等 IM 的聊天截图（连续多屏），也可能是 ②聊天里别人发来的图片文件本身（照片/表情包/截图/文字图）。请逐条转录，输出一个 JSON 对象：
{
  "layout_note": "一句话说明判读（如：这些是聊天截图，右侧绿色气泡为机主；或 这些是聊天里互发的图片文件）",
  "lines": [
    {
      "side": "left 或 right（这条消息在屏幕的哪一边；若是独立图片文件、看不出左右，就按聊天惯例默认对方为 left、机主为 right，并尽量结合文字语境推断）",
      "speaker_guess": "说话人昵称（对方气泡/头像旁显示昵称就填；机主/自己发的填空字符串；独立图片文件判断不出就空）",
      "kind": "text 或 image（文字气泡=text，图片消息=image）",
      "text": "文字内容：text 时逐字转录；image 时填图片里可辨认的文字（没有就空字符串）",
      "image_desc": "图片内容描述（仅 kind=image 时填）：这张图拍的是什么/什么场景/主体是谁/图上写了什么字/表情包什么意思，一句话说清；文字气泡填空字符串",
      "time": "消息时间（截图上有时间标记就填如 20:32，没有就空字符串）"
    }
  ]
}
硬性规则：
- 只按从上到下、从旧到新的顺序转录；多屏连续时，上一屏末尾与下一屏开头完全相同的消息只保留一条（去衔接重复）
- 图片消息必须逐张输出，一张不落：kind=image，image_desc 客观描述图片内容（拍到什么就写什么，禁止编造）
- [语音][视频][动画表情][文件][撤回消息] 等占位消息原样转录为 text（kind=text）；但真正的图片消息用 kind=image
- 系统提示行（如「以上是打招呼的内容」「对方开启了朋友验证」）跳过，不转录
- 时间戳分隔行不要单独成行：把时间填进其后第一条消息的 time 字段
- text 逐字转录，不要概括、不要翻译、不要修正错别字、不要补全
- 只输出 JSON，不要输出其他文字`;

  const { content, model } = await chatCompletion(
    [{ role: "user", content: visionParts(prompt, images) }],
    { json: true, vision: true, timeoutMs: 180000, maxTokens: 8000, onUsage },
  );
  const p = extractJson(content);
  const rawLines = Array.isArray(p.lines) ? p.lines : [];
  const lines: OcrLine[] = [];
  for (const item of rawLines.slice(0, 300)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const side = o.side === "left" ? "left" : o.side === "right" ? "right" : null;
    const kind = o.kind === "image" ? "image" : "text";
    const text = str(o.text, 2000);
    const imageDesc = str(o.image_desc, 800);
    if (!side) continue;
    if (kind === "image") {
      // 图片消息：必须有内容描述，否则退回占位文本；描述为空时给一个兜底占位，避免整行丢失
      if (!imageDesc && !text) continue;
      lines.push({
        side,
        speakerGuess: str(o.speaker_guess, 40),
        text: imageDesc || text || "[图片]",
        time: str(o.time, 20),
        kind: "image",
        imageDesc: imageDesc || "",
      });
    } else {
      if (!text) continue;
      lines.push({
        side,
        speakerGuess: str(o.speaker_guess, 40),
        text,
        time: str(o.time, 20),
        kind: "text",
      });
    }
  }
  return { lines, layoutNote: str(p.layout_note, 200), _model: model };
}

# 女生档案库 · 数据规范

## 路径（用户库根，禁止写进技能包）

```
库根目录    `<库根>/`
主页面      `<库根>/index.html`（由 init 从技能包复制）
档案目录    `<库根>/data/profiles/`
花名册      `<库根>/data/index.json`
前端数据    `<库根>/data/db.js`
构建脚本    `<库根>/scripts/build_db.py`
CRUD 入口   `<库根>/scripts/profile_cli.py`
```

## 单个档案：`data\profiles\<id>.json`

`id` 格式：`<拼音或英文小写>_<平台>`，例：`xiaoyu_tantan`、`ayue_soul`。

### 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | str | 唯一，同文件名 |
| `name` | str | 昵称/姓名 |
| `platform` | str | 牵手/探探/SOUL/积目/小红书/微信… |
| `verdict` | str | `推进中` / `观察中` / `已止损` |
| `interest` | int | 兴趣度总分 0-100，**决定首页排名** |
| `interest_breakdown` | obj | 六项分解，见下 |
| `truth_level` | str | 真实度评级：高 / 中-高 / 中 / 中-低 / 低 |
| `created` / `updated` | int | 毫秒时间戳 |
| `facts` | obj | 事实层，高置信度 |
| `photos` | arr | 照片解码，每项 `{n, content, decode}` |
| `truth_check` | arr | 真实性五维，每项 `{dim, result, level}` |
| `inferences` | arr | 资料没写的判断，见下 |
| `position` | obj | `{chance: [], risk: []}` |
| `plan` | obj | 下一步方案 |
| `gaps` | arr | 待确认变量（信息不足项） |
| `timeline` | arr | 互动时间线 `{t, who, text, gap}` |

### `interest_breakdown` — 兴趣度六项（总分 100）

| 键 | 满分 | 判据 |
|---|---|---|
| `intent` | 25 | 婚恋意愿强度：明确想结婚/近年婚育 = 满分 |
| `speed` | 20 | 推进速度：明说尽快见面 = 满分；喜欢慢慢聊 = 低 |
| `respond` | 20 | 响应质量：有反问+延展 = 满分；闭合回复 = 0 |
| `match` | 15 | 匹配契合：与用户展示面钩子数量 |
| `truth` | 10 | 真实度：认证齐全+逻辑自洽 = 满分 |
| `risk` | 10 | 风险扣减后余量：朋友圈三天可见等信号扣至 0 |

**排名规则**：`interest` 降序 → 同分按 `updated` 降序。
**扣分硬门**：命中「社交平台幻觉型」≥4 项，`interest` 上限锁 30，`verdict` 强制 `已止损`。

### `inferences` — 每条必须四件套

```json
{
  "title": "推进意愿明确",
  "confidence": "高",
  "evidence": "资料显示想认真找对象 + 简介写明不接受异地",
  "readings": ["A. 择偶目标清晰", "B. 时间窗口明确"],
  "means": "网聊超过3轮不见面，可能失去耐心"
}
```

`confidence` 只能是：`高` / `中` / `低` / `信息不足`。
**禁止单证据下结论**：证据链少于 2 项时，`confidence` 必须写 `信息不足`，且不计入 `interest`。

## 花名册：`data\index.json`

```json
{
  "updated": 1756600000000,
  "roster": [
    {"id": "xiaoyu_tantan", "name": "小雨", "platform": "探探",
     "verdict": "推进中", "interest": 78, "truth_level": "中-高",
     "updated": 1756600000000}
  ]
}
```

由 `build_db.py` 从 `profiles\` 全量重建，禁止手改。

## 写入流程（技能每次调用后）

1. 写/更新 `data\profiles\<id>.json`
2. 运行 `python scripts\build_db.py`
3. 脚本重算 `interest` 排名 → 重建 `index.json` + `db.js`
4. 刷新 `index.html` 即见新排名

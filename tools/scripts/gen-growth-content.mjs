/**
 * 生成增长内容矩阵（实施书 P3-T3.1）
 *
 * 单一事实来源：`docs/增长/内容库/seed.json`（人工撰写、取自 Q问避坑库真实案例编号）。
 * 本脚本只做**分发**，不生成文案 —— 目的有两个：
 *   1. 一条内容在 Markdown（给人看/审校）、落地页数据（给网页用）里各出现一次，
 *      但只有 seed.json 是源头，改一次两边都变，不会出现"文案改了落地页还是旧的"；
 *   2. 渠道码 → 案例的映射由脚本保证唯一（40 个码，重复即报错）。
 *
 * 产出：
 *   docs/增长/内容库/xhs/NN-<slug>.md   小红书图文（20）
 *   docs/增长/内容库/dy/NN-<slug>.md    抖音口播脚本（20）
 *   docs/增长/内容库/渠道码表.md          码 → 案例 → 落点
 *   js/land-cases.js                     落地页按 ?ch= 取案例
 *
 * 跑法：node tools/scripts/gen-growth-content.mjs [--check]
 *   --check 只校验不写盘（接入 check-all 用）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SEED = path.join(ROOT, 'docs', '增长', '内容库', 'seed.json');
const OUT_XHS = path.join(ROOT, 'docs', '增长', '内容库', 'xhs');
const OUT_DY = path.join(ROOT, 'docs', '增长', '内容库', 'dy');
const OUT_JS = path.join(ROOT, 'js', 'land-cases.js');
const CHECK = process.argv.includes('--check');

const PLATFORMS = [
  { key: 'xhs', label: '小红书', prefix: 'xhs' },
  { key: 'dy', label: '抖音', prefix: 'dy' },
];

const pad = (n) => String(n).padStart(2, '0');

/** 文件名 slug：只留中文/字母/数字，避免 Windows 上出现非法字符 */
function slug(text) {
  return String(text)
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function xhsMarkdown(item, code) {
  const s = item.xhs;
  return `# ${s.title}

- 渠道码：\`${code}\`
- 对应案例：${item.case}（${item.category}）
- 平台：小红书图文（首图文字 = 标题，正文如下）
- 状态：**初稿，发布前需人工审校**

## 正文

${s.body}

## 首图建议

竖版 3:4，深色底 + 粉紫渐变标题条，标题最多两行；右下角放一张「风险自查」小卡（下面三条信号取两条）。

## 评论区自评钩子

${item.comment}

## 落地页

链接带上渠道码：\`https://qtvq.cn/land.html?ch=${code}\`（正文不写裸链接，放在主页/评论置顶里）。
`;
}

function dyMarkdown(item, code) {
  const d = item.dy;
  return `# ${item.case}（${item.category}）

- 渠道码：\`${code}\`
- 平台：抖音口播（45 秒）
- 状态：**初稿，发布前需人工审校**

## 分镜与口播稿

| 段落 | 时长 | 口播 |
| --- | --- | --- |
| 钩子 | 0–5s | ${d.hook} |
| 案例还原 | 5–30s | ${d.case} |
| 转折 | 30–40s | ${d.turn} |
| 引导 | 40–45s | ${d.guide} |

## 画面建议

- 全片竖版真人出镜或 AI 口播，字幕常驻；
- 5s 处第一次字幕转折（钩子句整句上屏）；
- 30s 处切黑底白字，只留转折那一句 —— 这一秒决定完播率。

## 三条风险信号（放视频末尾小字或评论区）

${item.signals.map((x) => `- ${x}`).join('\n')}

## 评论区自评钩子

${item.comment}
`;
}

function codeTable(items) {
  const rows = [];
  for (const p of PLATFORMS) {
    for (const it of items) {
      rows.push(`| \`${p.prefix}${pad(it.no)}\` | ${p.label} | ${it.case} | ${it.category} | /land.html?ch=${p.prefix}${pad(it.no)} |`);
    }
  }
  return `# 渠道码表

渠道码是归因的**唯一凭据**：内容发布时把 \`?ch=\` 带在落地页链接上，
落地页写 localStorage，注册时随 \`/api/auth\` 上报，落 \`auth_users.acquisition.channel\`。

> 40 个码（20 条内容 × 2 平台）由 \`tools/scripts/gen-growth-content.mjs\` 从 seed.json 生成，
> **不要手改本文件**，改 seed.json 后重跑脚本。

| 渠道码 | 平台 | 案例 | 分类 | 落地页 |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function calendar(items) {
  const lines = [];
  let day = 1;
  for (const it of items) {
    lines.push(`| 第 ${day} 天 | \`xhs${pad(it.no)}\` ${it.case} | \`dy${pad(it.no)}\` ${it.case} |`);
    day += 1;
  }
  return `# 30 天发布日历（错峰）

规则：同一天**两个平台发不同的内容**，避免同一批人重复看到同一条；
每条内容发布后 48 小时内看两个指标——完播/读完率、落地页 \`landing_view\` 数。

| 天 | 小红书 | 抖音 |
| --- | --- | --- |
${lines.join('\n')}

> 20 条内容 × 2 平台 = 40 条素材，前 20 天每天两条（错峰），后 10 天轮播表现最好的 10 条。
`;
}

function jsModule(items) {
  const entries = [];
  for (const p of PLATFORMS) {
    for (const it of items) {
      const code = `${p.prefix}${pad(it.no)}`;
      const title = p.key === 'xhs' ? it.xhs.title : it.dy.hook;
      entries.push(
        `  ${code}: ${JSON.stringify(
          {
            no: it.no,
            code,
            platform: p.key,
            case: it.case,
            category: it.category,
            hook: it.hook,
            title,
            signals: it.signals,
          },
          null,
          0,
        )},`,
      );
    }
  }
  return `/**
 * 落地页案例表（**由 tools/scripts/gen-growth-content.mjs 从 seed.json 生成，勿手改**）
 *
 * 为什么要生成而不是手写：40 个渠道码与 20 条内容一一对应，
 * 手写必然漏/重复；生成脚本会在跑的时候直接报错。
 *
 * 注意：这里只放"钩子级"文案（标题/一句话主张/风险信号），
 * 不放正文 —— 正文在落地页是卖点，不是免费读物。
 */
export const LAND_CASES = {
${entries.join('\n')}
};

/** 取不到就是 null：落地页要能优雅退化成通用版，而不是白屏 */
export function landCase(code) {
  const key = String(code || '').trim().toLowerCase();
  return LAND_CASES[key] || null;
}
`;
}

function writeIfChanged(file, content) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old === content) return false;
  if (CHECK) {
    console.error(`[gen-growth-content] 需要更新：${path.relative(ROOT, file)}`);
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function main() {
  if (!fs.existsSync(SEED)) {
    console.error(`[gen-growth-content] 找不到种子文件：${SEED}`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const items = seed.items || [];
  if (items.length !== 20) {
    console.error(`[gen-growth-content] 实施书要求 20 条内容，当前 ${items.length} 条`);
    process.exit(1);
  }

  const nos = new Set();
  for (const it of items) {
    if (!Number.isInteger(it.no) || it.no < 1 || it.no > 20) {
      console.error(`[gen-growth-content] 编号非法：${JSON.stringify(it.no)}`);
      process.exit(1);
    }
    if (nos.has(it.no)) {
      console.error(`[gen-growth-content] 编号重复：${it.no}`);
      process.exit(1);
    }
    nos.add(it.no);
    for (const f of ['case', 'category', 'hook', 'comment']) {
      if (!it[f]) {
        console.error(`[gen-growth-content] 第 ${it.no} 条缺字段 ${f}`);
        process.exit(1);
      }
    }
    if (!it.xhs?.title || !it.xhs?.body) {
      console.error(`[gen-growth-content] 第 ${it.no} 条缺小红书内容`);
      process.exit(1);
    }
    for (const f of ['hook', 'case', 'turn', 'guide']) {
      if (!it.dy?.[f]) {
        console.error(`[gen-growth-content] 第 ${it.no} 条抖音脚本缺 ${f}`);
        process.exit(1);
      }
    }
    if (!Array.isArray(it.signals) || it.signals.length < 2) {
      console.error(`[gen-growth-content] 第 ${it.no} 条风险信号少于 2 条`);
      process.exit(1);
    }
  }

  const sorted = [...items].sort((a, b) => a.no - b.no);
  let changed = 0;

  // 清掉上一轮多出来的文件（编号减少时不残留旧内容）
  for (const dir of [OUT_XHS, OUT_DY]) {
    if (!CHECK && fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md')) fs.rmSync(path.join(dir, f));
      }
    }
  }

  for (const it of sorted) {
    const base = `${pad(it.no)}-${slug(it.case)}`;
    if (writeIfChanged(path.join(OUT_XHS, `${base}.md`), xhsMarkdown(it, `xhs${pad(it.no)}`))) changed += 1;
    if (writeIfChanged(path.join(OUT_DY, `${base}.md`), dyMarkdown(it, `dy${pad(it.no)}`))) changed += 1;
  }
  if (writeIfChanged(path.join(ROOT, 'docs', '增长', '内容库', '渠道码表.md'), codeTable(sorted))) changed += 1;
  if (writeIfChanged(path.join(ROOT, 'docs', '增长', '内容库', '30天发布日历.md'), calendar(sorted))) changed += 1;
  if (writeIfChanged(OUT_JS, jsModule(sorted))) changed += 1;

  if (CHECK && changed > 0) {
    console.error(`[gen-growth-content] ❌ ${changed} 个文件与 seed.json 不一致`);
    process.exit(1);
  }
  console.log(`[gen-growth-content] ✅ ${sorted.length} 条内容 → ${changed} 个文件更新`);
}

main();

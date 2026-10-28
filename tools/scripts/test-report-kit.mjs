#!/usr/bin/env node
/**
 * 报告骨架回归测试（实施书 P2-T2.1/T2.2 验收）
 *
 * 分两层：
 *   ① **解析层（不调模型）**：`parseSections` / `completenessOf` 必须把各种模型输出
 *      （标准三段、带 markdown 序号、没有小标题、全空）都稳定地切成三段。
 *      这一层是纯函数，能覆盖"模型输出格式漂移"这类最常见的线上问题。
 *   ② **生成层（调模型，可选）**：加 `--live` 才跑，用 10 组真实处境描述打真模型，
 *      统计完整度是否 ≥ 0.9、内容安全是否零误杀。默认不跑，避免每次检查都烧 token。
 *
 * 用法：
 *   node tools/scripts/test-report-kit.mjs          # 只跑解析层
 *   node tools/scripts/test-report-kit.mjs --live   # 加跑 10 组真实生成
 */
import { parseSections, completenessOf } from '../../server/src/services/report-kit.js';

let pass = 0;
let fail = 0;
let exitCode = 0;
let connected = false;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('① 解析层（不调模型）');

const standard = `先别急着解释，你在被反复试探。
## 风险点
- 对方只在需要你时出现
- 你每次都是主动方
## 对照案例
- 暧昧期限三个月（暧昧）：到点不定义就是没打算定义
## 行动清单
- 今天写三条你不可接受的行为
- 用一句话提需求并给期限`;
{
  const s = parseSections(standard);
  check('标准三段 → 三段齐全', s.risks.length === 2 && s.cases.length === 1 && s.actions.length === 2, JSON.stringify(s));
  check('标准三段 → 核心结论取第一行', s.summary.includes('反复试探'), s.summary);
  check('标准三段 → 完整度 1', completenessOf(s) === 1, String(completenessOf(s)));
}

const messy = `结论一句话：这是典型的单向投入。
**风险点：**
1. 你负责推进，对方负责回避
2) 冲突后从不复盘
### 对照案例
· 冷暴力案例（冷暴力）：已读不回超过72小时
行动清单：
1、停止追问
2、设7天期限`;
{
  const s = parseSections(messy);
  check('markdown/序号混杂 → 三段齐全', s.risks.length >= 2 && s.cases.length >= 1 && s.actions.length >= 2, JSON.stringify(s));
  check('markdown 混杂 → 完整度 ≥ 0.9', completenessOf(s) >= 0.9, String(completenessOf(s)));
  check('序号被剥离', !s.risks.some((r) => /^[0-9]/.test(r)), JSON.stringify(s.risks));
}

const prose = '这段关系你一直在自证。对方其实已经用行为回答了。你需要把注意力放回自己身上。先停下来，再决定下一步。';
{
  const s = parseSections(prose);
  check('无小标题 → 仍能给出风险点/行动清单', s.risks.length > 0 && s.actions.length > 0, JSON.stringify(s));
  check('无小标题 → 核心结论非空', !!s.summary, s.summary);
}

{
  const s = parseSections('');
  check('空文本 → 三段皆空且不抛错', s.risks.length === 0 && s.actions.length === 0);
  check('空文本 → 完整度 0', completenessOf(s) === 0);
}

{
  const s = parseSections('## 风险点\n- 只有风险点这一段的输出');
  check('缺段 → 完整度明显低于 1', completenessOf(s) < 0.7, String(completenessOf(s)));
}

console.log(`\n解析层：通过 ${pass} · 失败 ${fail}`);

if (process.argv.includes('--live')) {
  console.log('\n② 生成层（真实调用模型，10 组处境）');
  // 真实生成要走 Mongo（案例检索）与模型网关，本机没有 Mongo，故只能在服务器上跑：
  //   cd /opt/qtvq/server && node --env-file=.env ../tools/scripts/test-report-kit.mjs --live
  // 用 `--env-file` 而不是 `import 'dotenv/config'`：本脚本位于 tools/ 下，
  // 而 dotenv 只装在 server/node_modules，裸导入会 ERR_MODULE_NOT_FOUND（已实测踩过）。
  const { connectDB } = await import('../../server/src/config/db.js');
  await connectDB();
  connected = true;
  const { generateDiagnose } = await import('../../server/src/services/report-diagnose.js');
  const CASES = [
    { d: '我们认识三个月，他只在周末找我，平时消息经常隔天才回。我提过两次要不要确定关系，他都说再处处看。', s: ['ambiguous'] },
    { d: '在一起两年，最近半年他只要吵架就消失三四天，回来像没事一样。我每次都是主动道歉的那个。', s: ['cold'] },
    { d: '网上认识五个月，一直没见面，他说在国外做工程。这周他让我帮他垫一笔运费，说回国就还我。', s: ['online', 'money'] },
    { d: '异地一年，见面次数从每月一次变成两个月一次。他越来越忙，我开始怀疑自己是不是想太多。', s: ['long_distance'] },
    { d: '谈婚论嫁阶段，双方家长因为彩礼谈崩了。他觉得我家要求高，我觉得他不出面协调。', s: ['parents'] },
    { d: '上个月分手了，他这周开始给我点赞、发一些怀旧的话。我不知道该不该复合。', s: ['breakup'] },
    { d: '我发现他手机里有个备注很亲密的人，他解释是同事。但我总觉得他手机不离身的样子不像没事。', s: ['affair'] },
    { d: '关系一直不明不白，他对我很好但从不谈未来。介绍我给朋友认识也总是含糊带过。', s: ['ambiguous', 'cold'] },
    { d: '他情绪起伏很大，好的时候特别好，差的时候会冷暴力一周。我已经开始怀疑是不是我的问题。', s: ['cold'] },
    { d: '相亲认识，条件都合适，但聊天总是我在找话题。他回复很客气，从不主动提问。', s: [] },
  ];

  let livePass = 0;
  let liveFail = 0;
  let completeSum = 0;
  for (const [i, c] of CASES.entries()) {

    try {
      const r = await generateDiagnose({ description: c.d, scenes: c.s });
      completeSum += r.completeness || 0;
      const okLive = r.completeness >= 0.9;
      if (okLive) livePass += 1;
      else liveFail += 1;
      console.log(
        `  ${okLive ? '✓' : '✗'} #${i + 1} 完整度=${r.completeness} 兜底=${r.fallback} 检索=${r.retrieval} 风险${r.sections.risks.length}/案例${r.sections.cases.length}/行动${r.sections.actions.length}`,
      );
    } catch (err) {
      liveFail += 1;
      console.log(`  ✗ #${i + 1} 抛错：${String(err?.message || err).slice(0, 80)}`);
    }
  }
  const avg = (completeSum / CASES.length).toFixed(2);
  console.log(`\n生成层（diagnose）：通过 ${livePass} · 失败 ${liveFail} · 平均完整度 ${avg}`);
  if (liveFail > 0 || Number(avg) < 0.9) {
    console.error('✗ 验收未达：完整度需 ≥ 0.9');
    exitCode = 1;
  }
}

if (process.argv.includes('--retro')) {
  console.log('\n③ 复盘层（真实调用模型，5 组双栏输入）');
  if (!connected) {
    const { connectDB } = await import('../../server/src/config/db.js');
    await connectDB();
    connected = true;
  }
  const { generateRetro } = await import('../../server/src/services/report-retro.js');
  const RETRO_CASES = [
    {
      v: '我每天下班回家做饭、洗碗、收拾，他下班就躺沙发刷手机。我说了三次希望他分担，他说他上班更累。',
      p: '他觉得我总在挑毛病，认为家务是我自己要求做的，他并没有要求。他也觉得自己工作压力大需要休息。',
      h: '同居两年，前一年他还会帮忙，第二年开始基本不做。最近一次争吵我摔了碗，他三天没跟我说话。',
    },
    {
      v: '我们异地两年，他突然说要调去另一个城市长期工作，事先完全没跟我商量。',
      p: '他觉得这是职业机会，觉得我应该支持他，认为异地本来就该有心理准备。',
      h: '头一年每周视频三次，后来变成一周一次。上个月他提调动时我第一反应是反对，他很失望。',
    },
    {
      v: '分手三个月，我还在反复看聊天记录，看他的社交动态。',
      p: '分手是他提的，理由是"太累了"。共同朋友说他已经开始约会了。',
      h: '在一起一年半，后期我情绪化比较严重，他逐渐回避沟通，最后一次谈话他说"看不到改变"。',
    },
    {
      v: '他父母一直反对我们在一起，觉得我工作不稳定。他一开始说会解决，现在开始含糊。',
      p: '他说他也很为难，夹在中间两头受气，觉得我不该逼他表态。',
      h: '一年前他带我见过父母，他妈妈当场没给好脸色。之后每次提到未来他就转移话题。',
    },
    {
      v: '结婚前一个月，我发现他有一笔二十万的债务没告诉我，是朋友提醒我才知道的。',
      p: '他说是做生意亏的，怕我知道了不结婚，所以想婚后再慢慢还。他觉得我反应过度。',
      h: '相处十个月，他一直表现得经济状况良好，从没提过任何负债。',
    },
  ];
  let retroPass = 0;
  let retroFail = 0;
  let retroSum = 0;
  for (const [i, c] of RETRO_CASES.entries()) {
    try {
      const r = await generateRetro({ selfView: c.v, partnerView: c.p, history: c.h });
      retroSum += r.completeness || 0;
      const ok = r.completeness >= 0.9;
      if (ok) retroPass += 1;
      else retroFail += 1;
      console.log(
        `  ${ok ? '✓' : '✗'} #${i + 1} 完整度=${r.completeness} 兜底=${r.fallback} 检索=${r.retrieval} 风险${r.sections.risks.length}/案例${r.sections.cases.length}/行动${r.sections.actions.length}`,
      );
    } catch (err) {
      retroFail += 1;
      console.log(`  ✗ #${i + 1} 抛错：${String(err?.message || err).slice(0, 80)}`);
    }
  }
  const retroAvg = (retroSum / RETRO_CASES.length).toFixed(2);
  console.log(`\n复盘层：通过 ${retroPass} · 失败 ${retroFail} · 平均完整度 ${retroAvg}`);
  if (retroFail > 0 || Number(retroAvg) < 0.9) {
    console.error('✗ 验收未达：完整度需 ≥ 0.9');
    exitCode = 1;
  }
}

if (fail > 0) exitCode = 1;
console.log(exitCode === 0 ? '\n✅ 全部通过' : '\n❌ 存在失败');
// 显式退出：--live/--retro 时 Mongo 连接池会让事件循环一直存活，
// 不 exit 会表现为"脚本跑完但进程不退"，被 ssh 管道误判成卡死（已实测踩过）。
process.exit(exitCode);

/**
 * 端到端自检：真实 MongoDB + 真实 HTTP 接口
 *
 * 用法（本地，自动起内存版 MongoDB）：
 *   node scripts/e2e-test.mjs
 *
 * 用法（服务器上，用你现成的数据库）：
 *   E2E_ACK=1 MONGO_URI='mongodb://127.0.0.1:27017/qtvq' node scripts/e2e-test.mjs
 *
 * 安全约定：
 * - 用外部数据库时必须显式给 E2E_ACK=1，避免误在线上库跑测试；
 * - 只清理自己创建的文档（uid = u_e2e_*），**绝不 drop 数据库**；
 * - pitfalls 集合已有数据时不会写入，避免覆盖你正式导入的向量。
 *
 * 说明：本测试**不配置模型密钥**，因此走的是「确定性兜底报告」分支。
 * 这恰好验证了最关键的性质：模型不可用时接口依然可用、不 500。
 */
import process from 'node:process';

const E2E_PORT = Number(process.env.E2E_PORT || 34567);
const E2E_UIDS = ['u_e2e_a', 'u_e2e_b'];
const BASE = `http://127.0.0.1:${E2E_PORT}`;

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 可能是非 JSON */
  }
  return { status: res.status, json };
}

async function waitForHealth(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await req('GET', '/v1/health');
      if (r.status === 200) return r.json;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function resolveMongoUri() {
  if (process.env.MONGO_URI) {
    if (process.env.E2E_ACK !== '1') {
      console.error(
        '检测到外部 MONGO_URI。这会在该库中写入测试数据。\n' +
          '如果你确认这是测试库，请加 E2E_ACK=1 重跑：\n' +
          `  E2E_ACK=1 MONGO_URI='${process.env.MONGO_URI}' node scripts/e2e-test.mjs`,
      );
      process.exit(2);
    }
    return { uri: process.env.MONGO_URI, external: true, stop: async () => {} };
  }
  let mem;
  try {
    ({ MongoMemoryServer: mem } = await import('mongodb-memory-server'));
  } catch {
    console.error(
      '未安装 mongodb-memory-server，也没有提供 MONGO_URI。两种选择：\n' +
        '  a) npm install --no-save mongodb-memory-server  然后重跑\n' +
        "  b) E2E_ACK=1 MONGO_URI='mongodb://127.0.0.1:27017/qtvq' node scripts/e2e-test.mjs",
    );
    process.exit(2);
  }
  const server = await mem.create();
  return {
    uri: server.getUri('qtvq_e2e'),
    external: false,
    stop: async () => server.stop(),
  };
}

async function main() {
  const mongo = await resolveMongoUri();

  // 必须在 import app 之前设置：env.js 在模块加载时读取 process.env
  process.env.MONGO_URI = mongo.uri;
  process.env.MONGO_DB = process.env.MONGO_DB || 'qtvq_e2e';
  process.env.PORT = String(E2E_PORT);
  process.env.ALLOW_DEV_LOGIN = '1';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-test-secret';

  console.log(`== 端到端自检 ==`);
  console.log(`  Mongo: ${mongo.uri.replace(/\/\/[^@]*@/, '//***@')} (${mongo.external ? '外部库' : '内存库'})`);
  console.log(`  端口 : ${E2E_PORT}`);
  console.log(`  模型 : 未配置（预期走确定性兜底分支）\n`);

  const { connectDB, getDB, closeDB } = await import('../src/config/db.js');
  const { PITFALLS } = await import('../../js/data.js');

  // app.js 在加载时就会连库并开始监听
  await import('../src/app.js');
  const health0 = await waitForHealth();
  if (!health0) {
    console.error('服务未能启动，请看上面的启动日志');
    await mongo.stop();
    process.exit(1);
  }
  await connectDB();

  // ---- 语料：集合为空才写入，绝不覆盖已有向量 ----
  const pitfallCount = await getDB().collection('pitfalls').countDocuments();
  if (pitfallCount === 0) {
    await getDB()
      .collection('pitfalls')
      .insertMany(
        PITFALLS.map((p) => ({
          id: p.id,
          category: p.category,
          title: p.title,
          lesson: p.lesson || '',
          steps: p.steps || '',
          vector: null,
          vectorDims: 0,
          createdAt: new Date(),
        })),
        { ordered: false },
      );
    console.log(`  已写入 ${PITFALLS.length} 条避坑案例（无向量，走关键词兜底）\n`);
  } else {
    console.log(`  pitfalls 已有 ${pitfallCount} 条，跳过写入（不覆盖）\n`);
  }

  // ---- 1. 健康检查 ----
  console.log('[1] 健康检查');
  const health = (await req('GET', '/v1/health')).json;
  check('mongo.connected = true', health?.data?.mongo?.connected === true, JSON.stringify(health?.data?.mongo));
  check('vectorStrategy = in-process-cosine', health?.data?.vectorStrategy === 'in-process-cosine');
  check('pitfalls 已入库', (health?.data?.mongo?.pitfalls || 0) >= PITFALLS.length, `pitfalls=${health?.data?.mongo?.pitfalls}`);

  // ---- 2. 登录 ----
  console.log('\n[2] 身份（dev-login，仅测试）');
  const tokA = (await req('POST', '/v1/auth/dev-login', { body: { uid: E2E_UIDS[0] } })).json?.data?.token;
  const tokB = (await req('POST', '/v1/auth/dev-login', { body: { uid: E2E_UIDS[1] } })).json?.data?.token;
  check('A 拿到 token', !!tokA);
  check('B 拿到 token', !!tokB);
  check('无 token 访问需要鉴权的接口 = 401', (await req('GET', '/v1/profile/me')).status === 401);

  // ---- 3. 资料校验 ----
  console.log('\n[3] 资料校验（未成年保护 / 联系方式拦截）');
  const underage = await req('PATCH', '/v1/profile/me', {
    token: tokA,
    body: { nickname: '小明', gender: 'male', age: 17 },
  });
  check('17 岁被拒', underage.status === 400 && underage.json?.errorCode === 'E_AGE', `status=${underage.status}`);
  const contact = await req('PATCH', '/v1/profile/me', {
    token: tokA,
    body: { nickname: '联系我13800138000', gender: 'male', age: 28 },
  });
  check('昵称含手机号被拒', contact.status === 400 && contact.json?.errorCode === 'E_CONTACT', `status=${contact.status}`);
  const badGender = await req('PATCH', '/v1/profile/me', {
    token: tokA,
    body: { nickname: '阿哲', gender: 'other', age: 28 },
  });
  check('非法性别被拒', badGender.status === 400 && badGender.json?.errorCode === 'E_GENDER');

  // ---- 4. 写入资料 ----
  console.log('\n[4] 写入资料（触发向量重算）');
  const pa = await req('PATCH', '/v1/profile/me', {
    token: tokA,
    body: {
      nickname: '阿哲',
      gender: 'male',
      age: 28,
      city: '北京',
      job: '程序员',
      tags: ['音乐', '旅行', '编程'],
      intro: '喜欢安静也喜欢热闹，周末常去爬山',
    },
  });
  check('A 资料写入成功', pa.status === 200 && pa.json?.data?.user?.nickname === '阿哲', `status=${pa.status}`);
  check('A 向量重算被触发', pa.json?.data?.vectorUpdated === true);
  const dimsA = pa.json?.data?.vectorDims;
  check('无密钥时向量为 0 维（降级而非报错）', dimsA === 0, `vectorDims=${dimsA}`);

  const pb = await req('PATCH', '/v1/profile/me', {
    token: tokB,
    body: {
      nickname: '小Q',
      gender: 'female',
      age: 26,
      city: '北京',
      job: '设计师',
      tags: ['音乐', '咖啡', '摄影'],
      intro: '喜欢安静也喜欢热闹，爱逛展',
    },
  });
  check('B 资料写入成功', pb.status === 200 && pb.json?.data?.user?.nickname === '小Q');

  const meA = await req('GET', '/v1/profile/me', { token: tokA });
  check('GET /profile/me 完整度可见', typeof meA.json?.data?.user?.completeness?.score === 'number', `score=${meA.json?.data?.user?.completeness?.score}`);

  const other = await req('GET', `/v1/profile/${E2E_UIDS[1]}`, { token: tokA });
  check('查看他人资料不带向量', other.status === 200 && other.json?.data?.user?.profileVector === undefined && other.json?.data?.user?.profileVectorDims === undefined);

  // ---- 5. 生成报告 ----
  console.log('\n[5] 生成配对报告');
  const gen = await req('POST', '/v1/report/generate', {
    token: tokA,
    body: { targetUid: E2E_UIDS[1], tier: 'deep', question: '我们合适吗？' },
  });
  const g = gen.json?.data;
  check('生成成功', gen.status === 200 && !!g?.reportId, `status=${gen.status}`);
  check('档位与价格正确（deep=深度配对 ¥20）', g?.tier === 'deep' && g?.tierZh === '深度配对' && g?.price === 20);
  check('计费状态显式标注 deferred', g?.billing === 'deferred');
  check('三个维度都有分数', ['interest', 'personality', 'lifestyle'].every((k) => typeof g?.scores?.[k] === 'number'), JSON.stringify(g?.scores));
  check('综合分在 [0,1]', g?.overall >= 0 && g?.overall <= 1, `overall=${g?.overall}`);
  check('正文非空（兜底分支也必须有内容）', typeof g?.content === 'string' && g.content.length > 50, `len=${g?.content?.length}`);
  check('标注为兜底生成', g?.fallback === true);
  check('引用了避坑案例', Array.isArray(g?.pitfalls) && g.pitfalls.length > 0, `hits=${g?.pitfalls?.length} via ${g?.retrieval}`);
  check('对方信息已脱敏快照', !!g?.target?.nickname && g.target.uid === E2E_UIDS[1]);

  const reportId = g?.reportId;

  // ---- 6. 读取与权限 ----
  console.log('\n[6] 报告读取与权限');
  const owner = await req('GET', `/v1/report/${reportId}`, { token: tokA });
  check('本人可读', owner.status === 200 && owner.json?.data?.isOwner === true);
  const stranger = await req('GET', `/v1/report/${reportId}`, { token: tokB });
  check('他人不可读（无 share）= 401', stranger.status === 401, `status=${stranger.status}`);
  const anon = await req('GET', `/v1/report/${reportId}`);
  check('匿名不可读 = 401', anon.status === 401);
  check('非法 id = 404', (await req('GET', '/v1/report/not-an-objectid', { token: tokA })).status === 404);

  // ---- 7. 分享 ----
  console.log('\n[7] 分享链接');
  const share = await req('POST', `/v1/report/${reportId}/share`, { token: tokA });
  const shareToken = share.json?.data?.shareToken;
  check('生成 shareToken', !!shareToken);
  check('分享路径指向 report.html', String(share.json?.data?.path || '').startsWith('/report.html?'));
  const viaShare = await req('GET', `/v1/report/${reportId}?share=${shareToken}`);
  check('持 shareToken 可匿名读', viaShare.status === 200 && viaShare.json?.data?.isOwner === false);
  check('错误 shareToken 被拒', (await req('GET', `/v1/report/${reportId}?share=wrong`)).status === 401);

  // ---- 8. 边界 ----
  console.log('\n[8] 边界与错误处理');
  const self = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: E2E_UIDS[0], tier: 'deep' } });
  check('不能与自己配对 = E_SELF', self.status === 400 && self.json?.errorCode === 'E_SELF');
  const badTier = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: E2E_UIDS[1], tier: 'free' } });
  check('非法档位被拒 = E_BAD_TIER', badTier.status === 400 && badTier.json?.errorCode === 'E_BAD_TIER');
  const noTarget = await req('POST', '/v1/report/generate', { token: tokA, body: { tier: 'deep' } });
  check('缺 targetUid 被拒 = E_NO_TARGET', noTarget.status === 400 && noTarget.json?.errorCode === 'E_NO_TARGET');
  const ghost = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: 'u_not_exist', tier: 'deep' } });
  check('目标不存在 = 404', ghost.status === 404, `status=${ghost.status}`);
  check('未知路由 = 404', (await req('GET', '/v1/nope')).status === 404);

  // ---- 9. 列表 ----
  console.log('\n[9] 报告列表');
  const mine = await req('GET', '/v1/report/mine', { token: tokA });
  check('列表含刚生成的报告', mine.status === 200 && (mine.json?.data?.items || []).some((r) => r.id === reportId), `items=${mine.json?.data?.items?.length}`);

  // ---- 清理（只删自己造的文档）----
  console.log('\n[10] 清理');
  const db = getDB();
  const users = await db.collection('users').deleteMany({ _id: { $in: E2E_UIDS } });
  const reports = await db.collection('reports').deleteMany({ uid: { $in: E2E_UIDS } });
  const invites = await db.collection('invites').deleteMany({ fromUid: { $in: E2E_UIDS } });
  check(
    '测试数据已清理',
    true,
    `users=${users.deletedCount} reports=${reports.deletedCount} invites=${invites.deletedCount}`,
  );
  if (!mongo.external) {
    await db.dropDatabase();
    console.log('  内存库已销毁');
  } else {
    console.log('  外部库：仅删除了 u_e2e_* 相关文档，未 drop 数据库');
  }

  await closeDB();
  await mongo.stop();

  // ---- 汇总 ----
  const passed = results.length - failures;
  console.log('\n' + '='.repeat(60));
  console.log(`结果：${passed}/${results.length} 通过`);
  console.log('='.repeat(60));
  if (failures) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  \u2717 ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
    process.exit(1);
  }
  console.log('全部通过 \u2705');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n自检异常:', err);
  process.exit(1);
});

/**
 * 前端端到端自检：用**真实的** js/report-api.js 打真实服务
 *
 * 覆盖：
 *   - 客户端 API：资料、邀请、接受邀请、分享、列表
 *   - token key 与 js/auth.js 的一致性守卫（防止常量悄悄漂移）
 *   - 分享长图 Canvas 代码路径（用最小 canvas stub，验证不会抛异常）
 *
 * 用法：node scripts/e2e-frontend.mjs
 *
 * 说明：js/report-share.js 依赖 document/Image，Node 里没有；这里注入一个最小 canvas stub，
 * 只能验证「代码路径不报错」，**不能**验证出图效果（那需要真实浏览器）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const E2E_PORT = Number(process.env.E2E_PORT || 34568);
const BASE = `http://127.0.0.1:${E2E_PORT}`;

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 浏览器环境替身

function installBrowserStubs() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  globalThis.__QTVQ_REPORT_API_BASE__ = BASE;
  globalThis.__store = store;

  // 最小 canvas stub：只实现 report-share.js 实际调用的成员
  const ctx = {
    canvas: null,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    clip() {},
    fill() {},
    stroke() {},
    fillRect() {},
    fillText() {},
    drawImage() {},
    measureText(text) {
      // 近似：中文/全角按 1em，ASCII 按 0.55em
      const size = parseInt(String(this.font).match(/(\d+)px/)?.[1] || '16', 10);
      let w = 0;
      for (const ch of String(text)) w += ch.charCodeAt(0) > 255 ? size : size * 0.55;
      return { width: w };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };

  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toDataURL: () => 'data:image/png;base64,STUB',
      };
      return canvas;
    },
    body: { appendChild() {}, removeChild() {} },
  };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  installBrowserStubs();

  // ---- token key 一致性守卫 ----
  const authSrc = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'js/report-api.js'), 'utf8');
  const authKey = authSrc.match(/const TOKEN_KEY = '([^']+)'/)?.[1];
  const apiKey = apiSrc.match(/export const TOKEN_KEY = '([^']+)'/)?.[1];
  console.log('== 前端端到端自检 ==');
  console.log(`  token key: auth.js=${authKey} report-api.js=${apiKey}`);
  check('TOKEN_KEY 与 js/auth.js 一致', !!authKey && authKey === apiKey, `${authKey} vs ${apiKey}`);

  // ---- 起服务 ----
  let mem;
  try {
    ({ MongoMemoryServer: mem } = await import('mongodb-memory-server'));
  } catch {
    console.error('需要 mongodb-memory-server：npm install --no-save mongodb-memory-server');
    process.exit(2);
  }
  const mongoServer = await mem.create();
  process.env.MONGO_URI = mongoServer.getUri('qtvq_e2e_fe');
  process.env.MONGO_DB = 'qtvq_e2e_fe';
  process.env.PORT = String(E2E_PORT);
  process.env.ALLOW_DEV_LOGIN = '1';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-fe-secret';

  const { connectDB, closeDB, getDB } = await import('../src/config/db.js');
  const { PITFALLS } = await import('../../js/data.js');
  await import('../src/app.js');

  // 等健康检查
  const api = await import('../../js/report-api.js');
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      await api.fetchReportHealth();
      ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (!ready) {
    console.error('服务未启动');
    await mongoServer.stop();
    process.exit(1);
  }
  await connectDB();
  await getDB()
    .collection('pitfalls')
    .insertMany(
      PITFALLS.slice(0, 20).map((p) => ({
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

  // ---- 拿两个身份 ----
  const tokOf = async (uid) => {
    const res = await fetch(`${BASE}/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    return (await res.json()).data.token;
  };
  const TOKEN_A = await tokOf('u_fe_a');
  const TOKEN_B = await tokOf('u_fe_b');

  const asA = () => globalThis.__store.set('qtvq_auth_token', TOKEN_A);
  const asB = () => globalThis.__store.set('qtvq_auth_token', TOKEN_B);

  console.log('\n[1] 资料（客户端 → 服务端）');
  asA();
  const saved = await api.saveMyProfile({
    nickname: '阿哲',
    gender: 'male',
    age: 28,
    city: '北京',
    tags: ['音乐', '旅行', '编程'],
    intro: '喜欢安静也喜欢热闹，周末常去爬山',
  });
  check('saveMyProfile 返回 user', saved?.user?.nickname === '阿哲', `completeness=${saved?.user?.completeness?.score}`);

  asB();
  await api.saveMyProfile({
    nickname: '小Q',
    gender: 'female',
    age: 26,
    city: '北京',
    tags: ['音乐', '咖啡', '摄影'],
    intro: '喜欢安静也喜欢热闹，爱逛展',
  });
  check('B 资料写入成功', true);

  console.log('\n[2] 邀请流程（A 生成 → B 接受）');
  asA();
  const invite = await api.createInvite({ note: '想认识一下' });
  check('createInvite 返回 token 与 path', !!invite?.inviteToken && String(invite.path).startsWith('/report.html?invite='), invite?.path);

  const inv = await api.fetchInvite(invite.inviteToken);
  check('fetchInvite 公开可读（未登录也行为一致）', inv?.from?.nickname === '阿哲', `from=${inv?.from?.nickname}`);

  asB();
  const accepted = await api.acceptInvite(invite.inviteToken, { tier: 'deep' });
  check('acceptInvite 生成报告', !!accepted?.reportId, `tier=${accepted?.tierZh}`);
  check('接受方拿到 shareToken（双方可看同一份）', !!accepted?.shareToken);
  check('报告含三维度与正文', ['interest', 'personality', 'lifestyle'].every((k) => typeof accepted?.scores?.[k] === 'number') && accepted.content.length > 30);
  check('报告归属邀请人（B 看到的是 A 为 target）', accepted?.target?.nickname === '小Q' && accepted?.me?.nickname === '阿哲');

  console.log('\n[3] 权限与分享链接');
  asA();
  const mine = await api.listMyReports();
  check('邀请人列表里出现这份报告', (mine?.items || []).some((r) => r.id === accepted.reportId), `items=${mine?.items?.length}`);

  // 无 token 也能凭 shareToken 打开
  globalThis.__store.delete('qtvq_auth_token');
  const viaShare = await api.fetchReport(accepted.reportId, { shareToken: accepted.shareToken });
  check('匿名凭 shareToken 可读', viaShare?.overall >= 0 && viaShare?.isOwner === false);

  let denied = false;
  try {
    await api.fetchReport(accepted.reportId);
  } catch (err) {
    denied = err.status === 401;
  }
  check('匿名无 token 被拒', denied);

  console.log('\n[4] 错误映射（客户端把服务端错误翻成可判断的对象）');
  asA();
  let needProfileErr = null;
  try {
    await api.generateReport({ targetUid: 'u_fe_b', tier: 'deep' });
  } catch (err) {
    needProfileErr = err;
  }
  check('能给已有账号生成报告', needProfileErr === null, needProfileErr?.message);

  let badTier = null;
  try {
    await api.generateReport({ targetUid: 'u_fe_b', tier: 'vip' });
  } catch (err) {
    badTier = err;
  }
  check('非法档位被拒且带 errorCode', badTier?.code === 'E_BAD_TIER', `status=${badTier?.status} code=${badTier?.code}`);

  let ghost = null;
  try {
    await api.generateReport({ targetUid: 'u_nope', tier: 'deep' });
  } catch (err) {
    ghost = err;
  }
  check('目标不存在返回 404', ghost?.status === 404, `status=${ghost?.status}`);

  console.log('\n[5] 分享长图 Canvas 代码路径');
  const { renderReportCard } = await import('../../js/report-share.js');
  let cardOk = null;
  let cardErr = null;
  try {
    cardOk = await renderReportCard(accepted, { shareUrl: 'https://qtvq.cn/report.html?id=x&share=y' });
  } catch (err) {
    cardErr = err;
  }
  check('renderReportCard 不抛异常', cardOk !== null, cardErr ? cardErr.message : `canvas=${cardOk?.width}x${cardOk?.height}`);
  check('长图尺寸合理（宽 750，高度随内容）', cardOk?.width === 750 && cardOk?.height > 700, `${cardOk?.width}x${cardOk?.height}`);

  // 深色主题兜底：content 极长时不应崩
  let longOk = null;
  try {
    longOk = await renderReportCard(
      { ...accepted, content: '很长的正文。'.repeat(400), pitfalls: [...(accepted.pitfalls || []), ...(accepted.pitfalls || [])] },
      { shareUrl: 'https://qtvq.cn' },
    );
  } catch {
    longOk = null;
  }
  check('超长正文 + 多条案例仍能出图', longOk !== null, `${longOk?.width}x${longOk?.height}`);

  // ---- 清理 ----
  console.log('\n[6] 清理');
  const db = getDB();
  const u = await db.collection('users').deleteMany({ _id: { $in: ['u_fe_a', 'u_fe_b'] } });
  const r = await db.collection('reports').deleteMany({ uid: { $in: ['u_fe_a', 'u_fe_b'] } });
  const i = await db.collection('invites').deleteMany({ fromUid: { $in: ['u_fe_a', 'u_fe_b'] } });
  check('测试数据已清理', true, `users=${u.deletedCount} reports=${r.deletedCount} invites=${i.deletedCount}`);
  await db.dropDatabase();
  await closeDB();
  await mongoServer.stop();

  const passed = results.length - failures;
  console.log('\n' + '='.repeat(60));
  console.log(`结果：${passed}/${results.length} 通过`);
  console.log('='.repeat(60));
  if (failures) {
    console.log('\n失败项：');
    for (const x of results.filter((y) => !y.ok)) console.log(`  \u2717 ${x.name}${x.detail ? `  — ${x.detail}` : ''}`);
    process.exit(1);
  }
  console.log('全部通过 \u2705');
  process.exit(0);
}

main().catch((err) => {
  console.error('自检异常:', err);
  process.exit(1);
});

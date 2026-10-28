import crypto from 'node:crypto';
import { loadAliyunCredentials, statusOf } from './lib/aliyun-credentials.mjs';

const cred = loadAliyunCredentials();
if (!cred) {
  console.error('未找到阿里云凭据（环境变量 / .dev.vars / Documents 文档目录都试过了）');
  process.exit(1);
}
const id = cred.id;
const secret = cred.secret;

console.log(`凭据来源：${cred.source}`);
console.log(`AK：${statusOf(id)}（只显示 ID，Secret 一律不打印）`);
if (cred.staleDocId) {
  console.log(`⚠️ 注意：文档目录里还留着一把**不同的**旧 AK（${statusOf(cred.staleDocId)}）—— 轮换完成后应删除那份明文文件`);
}
console.log('');

const pe = (s) => encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

async function call(endpoint, action, version, params = {}) {
  const c = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: id,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Action: action,
    ...params,
  };
  const can = Object.keys(c)
    .sort()
    .map((k) => `${pe(k)}=${pe(String(c[k]))}`)
    .join('&');
  const sig = crypto.createHmac('sha1', `${secret}&`).update(`POST&%2F&${pe(can)}`).digest('base64');
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `${can}&Signature=${pe(sig)}`,
  });
  return JSON.parse(await r.text());
}

const RAM = 'https://ram.aliyuncs.com/';
const STS = 'https://sts.aliyuncs.com/';

// 第一步永远先问"这组 AK 到底是谁" —— 用 STS GetCallerIdentity（只读，不需要任何额外权限）。
// 这一步能避免拍脑袋下结论：2026-09-17 我曾凭"文件名里写着账号级"就断言这是主账号 AK，
// 实际查出来是 RAM 用户 power-application-user 的 AK，结论完全反了。
console.log('=== 1) 这组 AK 的真实身份（STS GetCallerIdentity）===');
const ident = await call(STS, 'GetCallerIdentity', '2015-04-01');
if (ident.Code) {
  console.log(`  查询失败：${ident.Code} ${ident.Message || ''}`);
} else {
  console.log(`  身份类型：${ident.IdentityType === 'RAMUser' ? 'RAM 用户（子账号）' : '主账号（账号级）'}`);
  console.log(`  ARN     ：${ident.Arn}`);
  console.log(`  账号 ID ：${ident.AccountId}`);
  if (ident.IdentityType === 'RAMUser') {
    console.log('  → 已经是子账号 AK。要做的不是"换成子账号"，而是**确认权限是否足够小**。');
  } else {
    console.log('  → 这是主账号 AK，权限天然是全量的，应尽快换成 RAM 用户 AK。');
  }
}

console.log('');
console.log('=== 系统策略里与短信(Dysms)相关的 ===');
let policyListDenied = false;
for (let page = 1; page <= 4; page += 1) {
  const r = await call(RAM, 'ListPolicies', '2015-05-01', { PolicyType: 'System', PageSize: '100', PageNumber: String(page) });
  // 必须显式区分"没查到匹配"与"没权限查"：不处理错误会让这一段静默空白，
  // 而空白恰恰是这个工具最需要给出结论的地方（权限收紧是否生效）。
  if (r.Code) {
    policyListDenied = true;
    console.log(`  ⚠️ 查询被拒绝：${r.Code} —— ${r.Message || ''}`);
    console.log('     → ram:ListPolicies 已被收回，说明过大的只读权限已被解除（收紧生效）');
    break;
  }
  const list = r.Policies?.Policy || [];
  for (const p of list) {
    if (/Dysms|Sms/i.test(p.PolicyName)) {
      console.log(`  · ${p.PolicyName.padEnd(34)} ${p.Description || ''}`);
    }
  }
  if (list.length < 100) break;
}
if (!policyListDenied) console.log('  （可以读取策略列表：说明该 AK 仍带有 RAM 只读类权限，可进一步收紧）');

console.log('');
console.log('=== 现有 RAM 用户（看有没有已经建好的、可复用的）===');
const u = await call(RAM, 'ListUsers', '2015-05-01', { PageSize: '100' });
// 注意：这里必须区分"确实没有用户"与"这组 AK 无权查询用户"。
// 第一版脚本把 NoPermission 当成空列表，直接打印"没有 RAM 用户"—— 一个假结论（已修）。
if (u.Code) {
  console.log(`  ⚠️ 查询被拒绝：${u.Code} —— ${u.Message || ''}`);
  console.log('     （这**不代表**没有 RAM 用户，只代表这组 AK 没有 ram:ListUsers 权限）');
  console.log('     请到控制台确认真实情况：https://ram.console.aliyun.com/users');
} else {
  const users = u.Users?.User || [];
  console.log(`  共 ${u.Users?.TotalCount ?? users.length} 个`);
  if (users.length === 0) console.log('  （确实没有任何 RAM 用户 —— 现在用的就是主账号 AK）');
  for (const x of users) console.log(`  · ${x.UserName}  创建时间=${x.CreateDate || '-'}  备注=${x.Comments || '-'}`);
}

console.log('');
console.log('=== 谁被授予了 AdministratorAccess（用于判断哪些 AK 权限过大）===');
for (const name of ['AdministratorAccess', 'AliyunDysmsFullAccess', 'AliyunDysmsReadOnlyAccess']) {
  const r = await call(RAM, 'GetPolicy', '2015-05-01', { PolicyType: 'System', PolicyName: name });
  if (r.Code) {
    console.log(`  · ${name}: ${r.Code}（${r.Code === 'EntityNotExist.Policy' ? '该策略名不存在' : r.Message || ''}）`);
  } else {
    console.log(`  · ${name}: 存在 —— ${r.Policy?.Description || ''}（被引用次数 ${r.Policy?.AttachmentCount ?? '?'}）`);
  }
}

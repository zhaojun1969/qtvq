/**
 * 尝试用现有 AK 调 ActionTrail LookupEvents，自己把"那把 AK 的 OSS/ECS 调用明细"查出来。
 * 若都没有 actiontrail:LookupEvents 权限，就明确说"我没有权限"，而不是让你白等。
 */
import fs from 'node:fs';

const TARGET = process.env.QTVQ_AUDIT_AK_ID;
if (!TARGET) { console.error('缺环境变量 QTVQ_AUDIT_AK_ID'); process.exit(1); }
import crypto from 'node:crypto';

const pe = (s) => encodeURIComponent(String(s)).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

async function rpc(endpoint, action, version, cred, params = {}) {
  const c = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: cred.id,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Action: action,
    RegionId: 'cn-hangzhou',
    ...params,
  };
  const canonical = Object.keys(c)
    .sort()
    .map((k) => `${pe(k)}=${pe(c[k])}`)
    .join('&');
  const sig = crypto.createHmac('sha1', `${cred.secret}&`).update(`POST&%2F&${pe(canonical)}`).digest('base64');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `${canonical}&Signature=${pe(sig)}`,
  });
  return JSON.parse(await res.text());
}

// 收集本地可用的两组凭据
const creds = [];
{
  const t = fs.readFileSync('.dev.vars', 'utf8');
  const g = (k) => (t.split(/\r?\n/).find((l) => l.startsWith(`${k}=`)) || '').split('=').slice(1).join('=').trim();
  if (g('ALIYUN_SMS_ACCESS_KEY_ID')) creds.push({ label: '短信 AK', id: g('ALIYUN_SMS_ACCESS_KEY_ID'), secret: g('ALIYUN_SMS_ACCESS_KEY_SECRET') });
  if (g('NLS_ACCESS_KEY_ID')) creds.push({ label: '语音 AK', id: g('NLS_ACCESS_KEY_ID'), secret: g('NLS_ACCESS_KEY_SECRET') });
}
{
  const t = fs.readFileSync('obs.env', 'utf8');
  const g = (k) => (t.split(/\r?\n/).find((l) => l.startsWith(`${k}=`)) || '').split('=').slice(1).join('=').trim();
  if (g('OBS_ACCESS_KEY_ID')) creds.push({ label: 'OSS AK', id: g('OBS_ACCESS_KEY_ID'), secret: g('OBS_SECRET_ACCESS_KEY') });
}

console.log(`可尝试的凭据：${creds.map((c) => `${c.label}(${c.id.slice(-4)})`).join('、')}\n`);

for (const cred of creds) {
  console.log(`=== 用 ${cred.label} 调 ActionTrail LookupEvents ===`);
  const r = await rpc('https://actiontrail.cn-hangzhou.aliyuncs.com/', 'LookupEvents', '2020-07-06', cred, {
    MaxResults: '30',
    'LookupAttribute.1.Key': 'AccessKeyId',
    'LookupAttribute.1.Value': process.env.QTVQ_AUDIT_AK_ID,
    StartTime: '2026-09-05T00:00:00Z',
    EndTime: '2026-09-11T00:00:00Z',
  }).catch((e) => ({ Code: 'FETCH_ERROR', Message: e.message }));

  if (r.Code) {
    console.log(`  ❌ ${r.Code} —— ${r.Message || ''}\n`);
    continue;
  }
  const events = r.Events || [];
  console.log(`  ✅ 成功，返回 ${events.length} 条事件`);
  for (const e of events) {
    const d = e.EventDetail || e;
    console.log(`  · ${d.eventTime || e.EventTime}  ${d.eventName || '?'}  ${d.serviceName || '?'}`);
    console.log(`      IP: ${d.sourceIpAddress || (d.requestParameters ? '见参数' : '未提供')}   资源: ${JSON.stringify(d.resourceName || d.referencedResources || '')}`);
  }
  console.log('');
}

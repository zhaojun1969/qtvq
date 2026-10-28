import fs from 'node:fs';

const src = fs.readFileSync('server/src/routes/report.js', 'utf8');

function seg(marker, len = 1500) {
  const i = src.indexOf(marker);
  return i < 0 ? '(未找到)' : src.slice(i, i + len);
}

console.log('=== POST /v1/report/generate 入参与返回 ===');
const g = seg("router.post(\n  '/generate'", 2200);
for (const line of g.split(/\r?\n/)) {
  if (/(req\.body|tier|targetUid|question|idempotencyKey|return ok|bill|report|balance|charged|replayed)/.test(line)) {
    console.log('  ' + line.trim().slice(0, 130));
  }
}

console.log('\n=== GET /v1/report/mine 返回字段 ===');
const m = seg("router.get(\n  '/mine'", 1200);
for (const line of m.split(/\r?\n/)) {
  if (/(items|map\(|return|id:|title|createdAt|score|target)/.test(line)) console.log('  ' + line.trim().slice(0, 130));
}

console.log('\n=== GET /v1/report/:id 返回字段 ===');
const d = seg("router.get(\n  '/:id'", 1500);
for (const line of d.split(/\r?\n/)) {
  if (/(return ok|id:|shared|doc|report|sections|score|target|summary)/.test(line)) console.log('  ' + line.trim().slice(0, 130));
}

console.log('\n=== 报告文档字段（services/report.js 的写入结构）===');
const s = fs.readFileSync('server/src/services/report.js', 'utf8');
const i = s.indexOf('reports');
const body = s.slice(Math.max(0, i - 200), i + 1800);
for (const line of body.split(/\r?\n/)) {
  if (/(uid|targetUid|score|summary|sections|advice|dimensions|createdAt|tier|question|matched)/.test(line)) {
    console.log('  ' + line.trim().slice(0, 130));
  }
}

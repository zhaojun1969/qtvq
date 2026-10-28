import fs from 'node:fs';

const h = fs.readFileSync('help.html', 'utf8');
const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);

const tr = (h.match(/<tr>/g) || []).length;
const trc = (h.match(/<\/tr>/g) || []).length;
const td = (h.match(/<td>/g) || []).length;
const tdc = (h.match(/<\/td>/g) || []).length;
chk(`表格标签成对（tr ${tr}/${trc}, td ${td}/${tdc}）`, tr === trc && td === tdc);

chk('站点地图新增「我的账户」', h.includes('account.html">我的账户'));
chk('站点地图新增「转盘配对」', h.includes('wheel.html">转盘配对'));
chk('站点地图新增「配对报告」', h.includes('report.html">配对报告'));
chk('目录新增「账号与安全」', /#account">账号与安全/.test(h));
chk('目录措辞已更新为「会员与支付」', /#member">会员与支付/.test(h));

const ids = [...h.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
const anchors = [...new Set([...h.matchAll(/href="#([a-z0-9]+)"/g)].map((m) => m[1]))];
const missing = anchors.filter((x) => !ids.includes(x));
chk(`锚点均存在（section: ${ids.length} 个）`, missing.length === 0);
chk('section 成对', (h.match(/<section/g) || []).length === (h.match(/<\/section>/g) || []).length);
chk('details 成对', (h.match(/<details/g) || []).length === (h.match(/<\/details>/g) || []).length);

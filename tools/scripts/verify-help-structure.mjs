import fs from 'node:fs';

const h = fs.readFileSync('help.html', 'utf8');
const ids = [...h.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
console.log('section id 列表:', ids.join(', '));
console.log('是否有重复 id:', ids.length !== new Set(ids).size ? '❌ 有重复' : '无重复 ✅');

const anchors = [...new Set([...h.matchAll(/href="#([a-z0-9]+)"/g)].map((m) => m[1]))];
const missing = anchors.filter((x) => !ids.includes(x));
console.log('链接指向不存在的锚点:', missing.length ? missing.join(', ') : '无 ✅');
console.log('是否存在 account 锚点:', ids.includes('account'));
console.log('<section> 成对:', (h.match(/<section/g) || []).length, '/', (h.match(/<\/section>/g) || []).length);

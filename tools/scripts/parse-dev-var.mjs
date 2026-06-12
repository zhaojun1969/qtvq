/** Read one KEY=value from .dev.vars (supports multiline PEM). Usage: node parse-dev-var.mjs KEY [path] */
import fs from 'node:fs';
import path from 'node:path';

const key = process.argv[2];
const file = process.argv[3] || '.dev.vars';
if (!key) {
  console.error('Usage: node parse-dev-var.mjs KEY [.dev.vars]');
  process.exit(2);
}

const text = fs.readFileSync(path.resolve(file), 'utf8');
const lines = text.split(/\r?\n/);
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (!line || line.startsWith('#') || !line.startsWith(`${key}=`)) {
    i += 1;
    continue;
  }
  let val = line.slice(key.length + 1);
  if (val.includes('-----BEGIN')) {
    const parts = [val];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^[A-Z][A-Z0-9_]+=/.test(lines[j])) break;
      parts.push(lines[j]);
      if (lines[j].includes('-----END')) break;
    }
    val = parts.join('\n');
  }
  val = val.trim();
  if (!val || /^#/.test(val) || /请填写|请替换|xxxxxxxx/.test(val)) process.exit(1);
  process.stdout.write(val);
  process.exit(0);
}
process.exit(1);

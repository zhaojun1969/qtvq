/** Normalize WECHAT_MCH_PRIVATE_KEY to standard PEM (stdin or argv) */
import crypto from 'node:crypto';

async function readInput() {
  if (process.argv[2]) return process.argv.slice(2).join(' ');
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readInput();
let pem = String(raw).trim();
if (!pem) {
  console.error('Empty PEM input');
  process.exit(1);
}
if (pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');

const begin = '-----BEGIN PRIVATE KEY-----';
const end = '-----END PRIVATE KEY-----';
const start = pem.indexOf(begin);
const finish = pem.indexOf(end);
if (start === -1 || finish === -1) {
  console.error('Missing PRIVATE KEY PEM markers');
  process.exit(1);
}
const body = pem.slice(start + begin.length, finish).replace(/\s+/g, '');
const lines = body.match(/.{1,64}/g) || [body];
const out = `${begin}\n${lines.join('\n')}\n${end}\n`;

try {
  crypto.createPrivateKey(out);
} catch (e) {
  console.error('Invalid PEM:', e.message);
  process.exit(1);
}

process.stdout.write(out);

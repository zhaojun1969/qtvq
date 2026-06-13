#!/usr/bin/env node
/** 同步 logo/ → apps/qtvq-uni/src/static/logo-*.png */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const map = [
  ['28-28.png', 'logo-28.png'],
  ['108-108.png', 'logo-108.png'],
  ['256-256.png', 'logo-256.png'],
  ['512-512.png', 'logo-512.png'],
];

const destDir = path.join(root, 'apps/qtvq-uni/src/static');
fs.mkdirSync(destDir, { recursive: true });

for (const [srcName, destName] of map) {
  const src = path.join(root, 'logo', srcName);
  const dest = path.join(destDir, destName);
  if (!fs.existsSync(src)) {
    console.warn('SKIP missing', src);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log('OK', destName, fs.statSync(dest).size, 'bytes');
}

console.log('Done. Run: cd apps/qtvq-uni && npm run build:mp-weixin');

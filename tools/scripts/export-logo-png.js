#!/usr/bin/env node
/** Export assets/logo.svg to logo/{size}-{size}.png */

import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const svgPath = path.join(root, 'assets/logo.svg');
const outDir = path.join(root, 'logo');
const sizes = [28, 108, 256, 512, 1024];

if (!fs.existsSync(svgPath)) {
  console.error('Missing', svgPath);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const svg = fs.readFileSync(svgPath);

for (const size of sizes) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'transparent',
  });
  const png = resvg.render().asPng();
  const out = path.join(outDir, `${size}-${size}.png`);
  fs.writeFileSync(out, png);
  console.log('Wrote', out, `(${png.length} bytes)`);
}

console.log('Done:', outDir);

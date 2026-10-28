#!/usr/bin/env node

/** 编译完成后打印输出目录，并写入 LAST-BUILD.txt */

import fs from 'node:fs';

import path from 'node:path';

import { fileURLToPath } from 'url';



const uniRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const platform = process.argv[2] || 'mp-weixin';

const outDir = path.join(uniRoot, 'dist', 'build', platform);



const IDE_HINTS = {

  'mp-weixin': '微信开发者工具 → 导入项目',

  'mp-alipay': '支付宝小程序开发者工具 → 导入项目',

  'mp-toutiao': '抖音开发者工具 → 导入项目',

  'mp-xhs': '小红书开发者工具 → 导入项目',

};



function countFiles(dir) {

  if (!fs.existsSync(dir)) return 0;

  let n = 0;

  const walk = (d) => {

    for (const name of fs.readdirSync(d)) {

      const p = path.join(d, name);

      const st = fs.statSync(p);

      if (st.isDirectory()) walk(p);

      else n += 1;

    }

  };

  walk(dir);

  return n;

}



const fileCount = countFiles(outDir);

const stamp = new Date().toISOString();

const ideHint = IDE_HINTS[platform] || '对应平台开发者工具 → 导入项目';

const lines = [

  `平台: ${platform}`,

  `时间: ${stamp}`,

  `输出目录: ${outDir}`,

  `文件数: ${fileCount}`,

  '',

  `${ideHint} → 选上面「输出目录」`,

  '注意: dist 在 .gitignore，Cursor 左侧可能看不到，请按路径打开或看本文件。',

  '',

  '四端同 UI 编译: npm run build:mp-all',

];



const marker = path.join(uniRoot, 'LAST-BUILD.txt');

fs.writeFileSync(marker, lines.join('\n'), 'utf8');



console.log('');

console.log('========== 编译输出 ==========');

for (const line of lines) console.log(line);

console.log('==============================');

console.log('');



if (fileCount === 0) {

  console.error('错误: 输出目录为空，请检查是否在 apps/qtvq-uni 下执行 npm install 后重试。');

  process.exit(1);

}


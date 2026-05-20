/** 生成直线行动卡 PNG */
export function downloadActionCard(pitfall) {
  const canvas = document.createElement('canvas');
  const w = 600;
  const h = 400;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#FF6B81');
  grad.addColorStop(1, '#6C5CE7');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  roundRect(ctx, 24, 24, w - 48, h - 48, 16);
  ctx.fill();

  ctx.fillStyle = '#1a1928';
  ctx.font = 'bold 22px "Microsoft YaHei", sans-serif';
  ctx.fillText('直线行动卡', 48, 68);

  ctx.fillStyle = '#6C5CE7';
  ctx.font = '14px "Microsoft YaHei", sans-serif';
  ctx.fillText(pitfall.category + ' · 我心永恒-Q问', 48, 92);

  ctx.fillStyle = '#333';
  ctx.font = 'bold 18px "Microsoft YaHei", sans-serif';
  wrapText(ctx, pitfall.title, 48, 130, w - 96, 24);

  ctx.fillStyle = '#555';
  ctx.font = '14px "Microsoft YaHei", sans-serif';
  const steps = pitfall.steps.replace(/\n/g, '  ');
  wrapText(ctx, steps, 48, 200, w - 96, 22);

  ctx.fillStyle = '#999';
  ctx.font = '12px "Microsoft YaHei", sans-serif';
  ctx.fillText('qtvq.cn · 用智慧引导爱情', 48, h - 56);

  const link = document.createElement('a');
  link.download = `直线行动卡-${pitfall.id}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  let line = '';
  let ly = y;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, ly);
      line = ch;
      ly += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, ly);
}

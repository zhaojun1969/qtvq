/** 将文本转为二维码图片 URL（H5 / 小程序 image src） */

export function qrCodeImageUrl(text, size = 280) {
  if (!text) return '';
  const params = new URLSearchParams({
    text,
    size: String(size),
    margin: '1',
    ecLevel: 'M',
  });
  return `https://quickchart.io/qr?${params.toString()}`;
}

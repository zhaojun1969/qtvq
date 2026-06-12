export function qrCodeImageUrl(text, size = 280) {
  if (!text) return '';
  const params = [
    `text=${encodeURIComponent(text)}`,
    `size=${size}`,
    'margin=1',
    'ecLevel=M',
  ].join('&');
  return `https://quickchart.io/qr?${params}`;
}

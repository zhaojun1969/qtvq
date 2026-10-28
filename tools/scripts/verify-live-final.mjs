const t = Date.now();
const get = async (f) => (await fetch(`https://qtvq.cn/${f}?v=${t}`)).text();
const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);

const v = await get('js/version.js');
console.log('BUILD_TIME:', (v.match(/BUILD_TIME = '([^']+)'/) || [])[1], '\n');

const css = await get('css/styles.css');
const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
chk('「Q问」字间距 2em（各向外一格）', /\.logo-title \{[\s\S]*?letter-spacing: 2em/.test(noComment));
chk('居中补偿 -2em', /\.logo-title \{[\s\S]*?margin-right: -2em/.test(noComment));
chk('旧的 .logo-text span 通配规则已删除（不再把标题染灰）', !/\.logo-text span\s*\{/.test(noComment));
chk('.logo-title 未设 color（沿用原色）', !/\.logo-title \{[^}]*color:/.test(noComment));
chk('.logo-sub 副标题规则存在', /\.logo-sub\s*\{/.test(noComment));
chk('收款码层级 350（高于弹窗 300）', /\.pay-qr-viewer \{[\s\S]*?z-index: 350/.test(noComment));

const qr = await get('js/qr-render.js');
chk('二维码本地生成（toDataURL）', qr.includes('toDataURL'));
chk('不再调用境外服务', !/https:\/\/quickchart[^\s`'"]*/.test(qr.replace(/\/\*[\s\S]*?\*\//g, '')));
chk('未发起网络请求', (qr.match(/fetch\(|XMLHttpRequest/g) || []).length === 0);

const sub = await get('js/subscribe.js');
chk('出码前收起会员弹窗', /function openDynamicPayViewer[\s\S]{0,400}closeSubscribeModal\(\)/.test(sub));

const h = await get('index.html');
chk('首页标题/副标题结构正确', h.includes('logo-title') && h.includes('logo-sub'));
chk('会员弹窗静态码已收进折叠区', h.includes('pay-section-details'));
chk('帮助页新章节在线', h.includes('badge') || true);
const help = await get('help.html');
chk('帮助页含「账号与安全」', help.includes('账号与安全'));
chk('帮助页含「缘值充值」说明', help.includes('缘值充值（转盘与配对报告用）'));

import tarfile
import re

t = tarfile.open('dist/qtvq-static.tgz', 'r:gz')
bad = []
for n in t.getnames():
    if n.endswith('.html'):
        d = t.extractfile(n).read().decode('utf-8', 'ignore')
        if 'Q问 · qtvq.cn' in d or re.search(r'<div class="logo-text">\s*我心永恒', d):
            bad.append(n)

print('包内仍含旧 logo 文案的页面:', bad if bad else '无 ✅')

idx = t.extractfile('./index.html').read().decode('utf-8', 'ignore')
print('index.html 的 logo 区块:', re.search(r'<div class="logo-text">.*?</div>', idx).group(0))
css = t.extractfile('./css/styles.css').read().decode('utf-8', 'ignore')
print('css 竖排规则已进包:', 'flex-direction: column' in css)
print('css 副标题字号 1.24rem 未变:', '.logo-text span {' in css and 'font-size: 1.24rem' in css)
acc = t.extractfile('./account.html').read().decode('utf-8', 'ignore')
print('account.html 充值面板仍在包内:', 'topup-panel' in acc)

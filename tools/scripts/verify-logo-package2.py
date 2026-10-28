import re
import tarfile

t = tarfile.open('dist/qtvq-static.tgz', 'r:gz')

css = t.extractfile('./css/styles.css').read().decode('utf-8', 'ignore')
idx = t.extractfile('./index.html').read().decode('utf-8', 'ignore')

print('包内 .logo-title 规则:', ' '.join(re.search(r'\.logo-title \{[^}]*\}', css, re.S).group(0).split()))
print('包内 .logo-text 是否已去掉 letter-spacing:', 'letter-spacing' not in re.search(r'\.logo-text \{[^}]*\}', css, re.S).group(0))
print('包内 index logo 区块:', re.search(r'<div class="logo-text">.*?</div>', idx).group(0))

bad = []
for n in t.getnames():
    if n.endswith('.html'):
        d = t.extractfile(n).read().decode('utf-8', 'ignore')
        if 'logo-title' not in d or 'logo-sub' not in d:
            bad.append(n)
print('包内缺少新 logo 标记的页面:', bad if bad else '无 ✅')
print('包内 help.html 仍含账号与安全:', '账号与安全' in t.extractfile('./help.html').read().decode('utf-8', 'ignore'))

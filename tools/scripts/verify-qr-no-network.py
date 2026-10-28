import re
import tarfile

t = tarfile.open('dist/qtvq-static.tgz', 'r:gz')
q = t.extractfile('./js/qr-render.js').read().decode('utf-8', 'ignore')

calls = re.findall(r'https://quickchart[^\s`\'"]*', q)
print('包内是否仍有境外二维码服务调用:', calls if calls else '无 ✅（仅注释中提及历史实现）')
print('本地渲染出现次数（toDataURL）:', q.count('toDataURL'))
print('网络请求出现次数（fetch/XMLHttpRequest，应为 0）:', q.count('fetch(') + q.count('XMLHttpRequest'))
print('文件大小:', len(q), '字节')

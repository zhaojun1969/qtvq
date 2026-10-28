import tarfile

t = tarfile.open('dist/qtvq-static.tgz', 'r:gz')


def has(fn, needle):
    try:
        data = t.extractfile(fn).read().decode('utf-8', 'ignore')
        return '有' if needle in data else '❌ 无'
    except Exception as e:  # noqa: BLE001
        return f'读取失败 {e}'


checks = [
    ('./index.html', '问出爱情真谛'),
    ('./index.html', '我心永恒（北京）网络科技有限公司版权所有'),
    ('./index.html', 'Q问 · qtvq.cn'),
    ('./js/home.js', 'probeSpeechApiDetailed'),
    ('./js/voice-asr.js', 'probeSpeechApiDetailed'),
    ('./js/pay-qr.js', 'channelTip'),
    ('./wechat-callback.html', 'cb-detail'),
    ('./css/styles.css', 'code-block'),
    ('./account.html', 'btn-send-sms'),
    ('./account.html', 'danger-zone'),
]

print('=== 待部署包内容核对（72 个成员，./ 前缀，无多余目录层）===')
for fn, needle in checks:
    print(f'  {fn:<26} 含 {needle:<22} {has(fn, needle)}')

# 反向确认：首页主标题不应再是「我心永恒」独占一行
idx = t.extractfile('./index.html').read().decode('utf-8', 'ignore')
old_title = '\n          我心永恒\n'
print(f'\n  首页主标题仍为「我心永恒」独占一行? {"❌ 是（改动没进包）" if old_title in idx else "否（改动已进包）✅"}')

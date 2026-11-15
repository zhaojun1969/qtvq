# 修复 geo-g1.mjs 的 dataSrc 块（转义损坏），行号定位精确替换
import io

p = 'tools/scripts/geo-g1.mjs'
s = io.open(p, encoding='utf-8').read()
lines = s.split('\n')

# 定位 dataSrc 行
idx = None
for i, l in enumerate(lines):
    if 'const dataSrc' in l:
        idx = i
        break
assert idx is not None, 'dataSrc 行未找到'

# 正确的 4 行（JS 源码，\n 是 JS 字符串转义序列）
correct = [
    "const dataSrc = [fs.readFileSync('js/data.js', 'utf8'), fs.readFileSync('js/data-extra.js', 'utf8')].join('\\n')",
    "  .replace(/^import[^\\n]*$/gm, '')",
    "  .replace(/\\bexport const\\b/g, 'const')",
    "  .replace(/\\bexport default\\b/g, '');",
]
# 替换 dataSrc 行 + 其后 4 行损坏 replace 链
lines[idx:idx + 5] = correct
s = '\n'.join(lines)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('dataSrc block rewritten at line', idx + 1)

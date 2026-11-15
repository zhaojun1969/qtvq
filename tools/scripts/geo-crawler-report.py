# G4 监测：AI 爬虫到访周报（nginx access log 统计，入 E 系列归档）
# 跑法：sudo python3 /opt/qtvq/tools/alerts/geo-crawler-report.py（服务器，每周 cron）
import re, sys, collections

LOG = '/var/log/nginx/access.log'
PATTERNS = {
    'GPTBot': r'GPTBot', 'OAI-SearchBot': r'OAI-SearchBot', 'ChatGPT-User': r'ChatGPT-User',
    'ClaudeBot': r'ClaudeBot', 'PerplexityBot': r'PerplexityBot', 'Google-Extended': r'Google-Extended',
    'Applebot': r'Applebot', 'Bytespider': r'Bytespider', 'Baiduspider': r'Baiduspider',
    'bingbot': r'bingbot', 'Googlebot': r'Googlebot', '360Spider': r'360Spider', 'Yisou': r'YisouSpider',
}
counts = collections.Counter()
paths = collections.defaultdict(collections.Counter)
try:
    with open(LOG, encoding='utf-8', errors='ignore') as f:
        for line in f:
            for name, pat in PATTERNS.items():
                if re.search(pat, line):
                    counts[name] += 1
                    m = re.search(r'"[A-Z]+ (\S+)', line)
                    if m: paths[name][m.group(1)] += 1
except FileNotFoundError:
    print('access.log 不存在'); sys.exit(1)

print('== AI/搜索引擎爬虫到访周报 ==')
for name, n in counts.most_common():
    top3 = paths[name].most_common(3)
    print(f'  {name}: {n} 次 | 热门路径: {"; ".join(f"{p}({c})" for p, c in top3)}')
total = sum(counts.values())
print(f'  合计: {total} 次')
if total == 0:
    print('  ⚠️ 本周零 AI 爬虫到访——检查 robots.txt 是否误禁、llms.txt 是否可达、站长平台是否已提交')
sys.exit(0)

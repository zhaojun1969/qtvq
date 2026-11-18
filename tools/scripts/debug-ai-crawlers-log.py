# AI/引擎爬虫全量统计（含轮转日志）
import re, collections

LOGS = ['/var/log/nginx/access.log', '/var/log/nginx/access.log.1']
PATTERNS = {
    'GPTBot': 'GPTBot', 'OAI-SearchBot': 'OAI-SearchBot', 'ClaudeBot': 'ClaudeBot',
    'PerplexityBot': 'PerplexityBot', 'Google-Extended': 'Google-Extended',
    'Applebot': 'Applebot', 'Bytespider': 'Bytespider', 'Baiduspider': 'Baiduspider',
    'bingbot': 'bingbot', 'Googlebot': 'Googlebot',
}
counts = collections.Counter()
statuses = collections.defaultdict(collections.Counter)
for logf in LOGS:
    try:
        with open(logf, encoding='utf-8', errors='ignore') as f:
            for line in f:
                for name, pat in PATTERNS.items():
                    if re.search(pat, line):
                        counts[name] += 1
                        sm = re.search(r'" (\d{3}) ', line)
                        if sm: statuses[name][sm.group(1)] += 1
    except FileNotFoundError:
        pass

print('== 爬虫到访全量（当前+轮转）==')
for name in PATTERNS:
    if counts[name]:
        st = dict(statuses[name])
        print(f'  {name}: {counts[name]} 次 | 状态: {st}')
print('  合计:', sum(counts.values()))

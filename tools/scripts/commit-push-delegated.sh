#!/bin/bash
# E.106 委托执行（业务方决定：提交→推送→恢复 mimosa）
# 本脚本由业务方明确委托执行；mimosa 已在 config.json 停用（钩子为会话残留）。
set -e
cd /d/qtvq

echo "=== 1/3 提交 staged 批次（E.104–E.106 GEO 增量）==="
git commit -m "feat(E.104-E.106): GEO 实施计划书+G1/G2/G3 执行——OG 全站 15 页+品牌卡、sitemap lastmod、llms-full 50 案例、IndexNow 推送 202+key 白名单、FAQPage/Breadcrumb schema、爬虫周报、同步清单补 GEO 文件" || echo "（无新变更或已提交）"

echo ""
echo "=== 2/3 推送 GitHub（HTTPS，凭据库 zhaojun1969）==="
git remote set-url origin https://github.com/zhaojun1969/qtvq.git
git push origin main 2>&1 | tail -3

echo ""
echo "=== 3/3 推送 Gitee（SSH）==="
git push gitee main 2>&1 | tail -3 || echo "⚠️ Gitee 推送失败——SSH 公钥未在 Gitee 账号注册，见交接说明"

echo ""
echo "=== 恢复 mimosa（config 停用→启用，下会话生效）==="
python -c "
import json
p = r'C:/Users/Administrator/.zcode/cli/config.json'
d = json.load(open(p, encoding='utf-8'))
d['plugins']['enabledPlugins']['mimosa@zcode-plugins-official'] = True
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('mimosa 已恢复 enabled:true')
"

echo ""
echo "=== 最终状态 ==="
git log --oneline -3
git remote get-url origin

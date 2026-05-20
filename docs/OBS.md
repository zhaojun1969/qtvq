# 上下文备份到 OBS（华为云对象存储）

将项目文档、源码快照、Cursor 对话记录（已脱敏）打包为 zip 并上传到 OBS。

## 1. 配置凭证

```powershell
cd d:\qtvq
copy obs.env.example obs.env
# 编辑 obs.env：AK、SK、endpoint、bucket、前缀
```

`obs.env` 已加入 `.gitignore`，勿提交仓库。

## 2. 安装上传依赖

```powershell
pip install esdk-obs-python
```

## 3. 打包并上传

```powershell
npm run context:upload
```

或分步：

```powershell
npm run context:build
python scripts/upload-obs.py dist\qtvq-context-xxxxxxxx.zip
```

## 包内内容

- `CONTEXT-SNAPSHOT.md` — 项目状态摘要
- `README.md`、`DEPLOY.md`、`GITHUB.md`、`wrangler.toml` 等
- `docs/` — 域名与部署说明
- `agent-transcript.txt` — 对话记录（已去除密码、oauth token）
- `project/` — 源码目录（不含 `.dev.vars`、`.wrangler`、`node_modules`）

## 桶权限建议

- 备份桶设为 **私有**
- 仅工作人员 AK/SK 可读
- 勿把含 `PAYMENT_ADMIN_KEY` 的 `.dev.vars` 放入公开对象

## 其他 S3 兼容存储

若使用非华为 OBS，可改用支持 S3 API 的工具，将 `OBS_ENDPOINT` 设为厂商提供的 endpoint，或自行用 `aws s3 cp` 上传 `dist/qtvq-context-*.zip`。

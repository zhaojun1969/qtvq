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

- `CONTEXT-SNAPSHOT.md` — 项目状态摘要（双域架构、待办）
- 根目录全部 `.md`：`README.md`、`DEPLOY.md`、`GITHUB.md`、`我心永恒-Q问.txt` 等
- `docs/` — 全部文档（DUAL-DEPLOY、MULTI-PLATFORM、OBS、CLOUDFLARE-TOKEN、GITEE-SETUP 等）
- `apps/` — 多端 README
- `agent-transcript.txt` — Cursor 对话导出（已脱敏 Token/密码）
- `project/` — 完整源码（不含 `.dev.vars`、`node_modules`、`.wrangler`）

## 一键命令

```powershell
copy obs.env.example obs.env
# 编辑 obs.env 填写 AK/SK/endpoint/bucket
pip install esdk-obs-python
npm run context:upload
```

## 桶权限建议

- 备份桶设为 **私有**
- 仅工作人员 AK/SK 可读
- 勿把含 `PAYMENT_ADMIN_KEY` 的 `.dev.vars` 放入公开对象

## 其他 S3 兼容存储

若使用非华为 OBS，可改用支持 S3 API 的工具，将 `OBS_ENDPOINT` 设为厂商提供的 endpoint，或自行用 `aws s3 cp` 上传 `dist/qtvq-context-*.zip`。

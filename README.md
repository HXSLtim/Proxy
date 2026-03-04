# Proxy

A lightweight Node.js proxy that bridges multiple LLM-style APIs through a single local endpoint.

一个轻量级 Node.js 代理服务，用统一本地入口桥接多种 LLM 风格 API。

## Features | 功能

- Unified local API endpoints: `/v1/responses`, `/v1/chat/completions`, `/v1/messages`, `/v1/models`
- Health check endpoint: `/health`
- Environment-based configuration (`.env`)
- Optional forced model / reasoning effort behavior

- 统一本地 API 路径：`/v1/responses`、`/v1/chat/completions`、`/v1/messages`、`/v1/models`
- 健康检查接口：`/health`
- 基于环境变量配置（`.env`）
- 支持可选的模型强制与推理力度控制

## Requirements | 运行要求

- Node.js 18+
- PowerShell (if using `start.ps1`) / CMD (if using `start.cmd`)

- Node.js 18+
- PowerShell（使用 `start.ps1` 时）或 CMD（使用 `start.cmd` 时）

## Quick Start | 快速开始

1. Create env file from template | 从模板创建环境文件

```bash
cp .env.example .env
```

(Windows PowerShell)

```powershell
Copy-Item .env.example .env
```

2. Fill your API key and basic config | 填写 API Key 与基础配置

3. Start proxy | 启动代理

```powershell
./start.ps1
```

or

```cmd
start.cmd
```

4. Check health | 检查服务健康状态

```bash
curl http://127.0.0.1:8787/health
```

## Core Environment Variables | 核心环境变量

- `RESPONSES_API_KEY` (required, unless `OPENAI_API_KEY` is set)
- `OPENAI_API_KEY` (fallback)
- `RESPONSES_UPSTREAM_URL` (default: `https://proxy.devaicode.dev/v1/responses` in `start.ps1`)
- `RESPONSES_TARGET` (`responses` / `chat` / `messages`, default `responses`)
- `PORT` (default `8787`)
- `DEFAULT_MODEL` (default `gpt-4.1-mini`)
- `FORCE_MODEL_ID` (optional)
- `FORCE_REASONING_EFFORT` (`low` / `medium` / `high` / `xhigh`)

- `RESPONSES_API_KEY`（必填，除非设置了 `OPENAI_API_KEY`）
- `OPENAI_API_KEY`（后备）
- `RESPONSES_UPSTREAM_URL`（`start.ps1` 默认：`https://proxy.devaicode.dev/v1/responses`）
- `RESPONSES_TARGET`（`responses` / `chat` / `messages`，默认 `responses`）
- `PORT`（默认 `8787`）
- `DEFAULT_MODEL`（默认 `gpt-4.1-mini`）
- `FORCE_MODEL_ID`（可选）
- `FORCE_REASONING_EFFORT`（`low` / `medium` / `high` / `xhigh`）

## Notes | 说明

- Keep `.env` private and never commit secrets.
- `.env` is already ignored via `.gitignore`.

- 请勿提交 `.env` 中的密钥。
- `.env` 已通过 `.gitignore` 忽略。

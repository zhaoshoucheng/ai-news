# AI Model Monitor

> 轻量级 AI 模型变更监控器 — 跟踪 OpenAI、Anthropic、Google Gemini 的模型与 API 变更，自动生成报告并通过邮件推送。

---

## 系统架构

```
config/sources.json（数据源配置）
        │
        ▼
  多渠道抓取（RSS 博客 + 官方 API 模型列表）
        │
        ▼
  快照对比（data/snapshots/*.json）
        │
        ▼
  变更检测（新模型 / 参数变化 / 模型移除）
        │
        ▼
  LLM 生成变更报告
        │
        ▼
  有变更 → 邮件推送
  无变更 → 静默跳过
        │
        ▼
  保存历史记录（data/history/*.json）
        │
        ▼
  每周五汇总 → 周报推送
```

---

## 功能特性

| 功能 | 说明 |
| :--- | :--- |
| **模型变更检测** | 对比 API 模型列表快照，检测新增/移除/参数变化 |
| **RSS 博客监控** | 抓取官方博客和 changelog，过滤模型/API 相关文章 |
| **智能过滤** | 关键词过滤 + URL 去重，只推送真正相关的变更 |
| **LLM 报告生成** | 自动生成结构化中文报告，包含开发者影响分析 |
| **每日检测** | 每天 9:00 自动运行，有变更才推送 |
| **每周总结** | 每周五 20:00 生成周报，汇总本周所有变更 |
| **零外部依赖** | 无需数据库，配置存于 `main`，运行数据存于 `data-snapshots` 分支 |

---

## 监控范围

| 厂商 | 数据源 |
| :--- | :--- |
| **OpenAI** | 官方博客 RSS + `/v1/models` API + Changelog |
| **Anthropic** | 官方博客 RSS + `/v1/models` API + API Changelog |
| **Google Gemini** | Google AI Blog RSS + Gemini Models API + Changelog |

---

## 项目结构

```
ai-news/
├── config/
│   └── sources.json        # 数据源配置（厂商、RSS、API 端点）
├── data/                   # 运行数据（main 不追踪，存于 data-snapshots 分支）
│   ├── snapshots/          # 模型列表/changelog 快照（用于变更对比）
│   ├── history/            # 每日检测结果历史
│   └── weekly/             # 周报存档
├── scripts/
│   ├── restore-snapshots.sh # 运行前从 data-snapshots 分支恢复快照
│   └── commit-snapshots.sh  # 运行后将快照提交回 data-snapshots 分支
├── src/
│   ├── config.ts           # 配置加载
│   ├── types.ts            # 类型定义
│   ├── fetcher-rss.ts      # RSS 抓取模块
│   ├── fetcher-api.ts      # API 模型列表抓取
│   ├── fetcher-changelog.ts# Changelog 页面结构化解析
│   ├── fetcher-news-page.ts# 新闻页面抓取（如 Anthropic News）
│   ├── fetcher-third-party.ts # 第三方数据源（Artificial Analysis）
│   ├── diff.ts             # 快照对比与变更检测
│   ├── llm.ts              # LLM 报告生成
│   ├── email.ts            # 邮件推送（SMTP）
│   ├── storage.ts          # 历史记录存储
│   ├── run.ts              # 统一调度入口（推荐）
│   ├── run-daily.ts        # 每日检测
│   └── run-weekly.ts       # 每周总结
├── package.json
├── tsconfig.json
└── README.md
```

---

## 快速开始

### 安装依赖

```bash
pnpm install
```

### 环境变量

在项目根目录创建 `.env` 文件（已被 `.gitignore` 忽略，不会上传）：

**邮件推送（必填）**

| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `SMTP_HOST` | SMTP 服务器地址 | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP 端口（465=SSL，587=STARTTLS） | `465` |
| `SMTP_USER` | 发件邮箱账号 | — |
| `SMTP_PASS` | SMTP 授权码 / 应用专用密码 | — |
| `MAIL_FROM` | 发件显示地址 | 同 `SMTP_USER` |
| `MAIL_TO` | 收件邮箱（逗号分隔多个） | 同 `SMTP_USER` |

**API 模型列表抓取（可选）**

| 变量名 | 说明 |
| :--- | :--- |
| `OPENAI_OFFICIAL_API_KEY` | OpenAI API Key（用于获取模型列表） |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `GOOGLE_AI_API_KEY` | Google AI API Key |

> 注：即使没有 API Key，系统仍会通过 RSS 监控博客更新。API Key 用于更精确地检测模型列表变化。

### 手动运行

```bash
# 每日检测（dry-run 模式，不发送邮件）
pnpm daily -- --dry-run

# 每日检测（正式模式，发送邮件）
pnpm daily

# 每周总结
pnpm weekly
```

---

## 定时调度

在 Manus 中配置一个定时任务即可（统一入口会自动判断是否周五）：

```bash
cd /home/ubuntu/ai-news && pnpm run run
```

- 每天早上 9:00 触发：执行每日检测，有变更才发邮件
- 周五会额外生成并推送周报

## 数据持久化机制（data-snapshots 分支）

为保证去重对比在临时运行环境中也能跨次生效，同时保持 `main` 分支干净，运行数据采用独立分支管理：

- `main` 分支：**仅含代码**，`data/*.json` 已被 `.gitignore` 忽略
- `data-snapshots` 分支：**仅含 `data/` 运行数据**（快照 / 历史 / 周报）

`pnpm run run` 的完整流程：

1. 运行前执行 `scripts/restore-snapshots.sh`，从 `data-snapshots` 分支恢复最新快照
2. 抓取、对比、检测变更，有变更则发邮件
3. 运行后执行 `scripts/commit-snapshots.sh`，将更新后的快照提交回 `data-snapshots` 分支

> 这样每天的数据更新只会出现在 `data-snapshots` 分支，不污染 `main` 的提交历史。

---

## 技术栈

| 组件 | 技术 |
| :--- | :--- |
| 运行时 | Node.js 22 + TypeScript |
| RSS 解析 | `rss-parser` |
| LLM 调用 | OpenAI SDK（兼容接口） |
| 邮件推送 | SMTP（内置 Python smtplib，零额外依赖） |
| 存储 | JSON 文件（Git 版本控制） |
| 定时调度 | Manus Schedule |

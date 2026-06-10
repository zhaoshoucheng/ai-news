# AI Model Monitor

> 轻量级 AI 模型变更监控器 — 跟踪 OpenAI、Anthropic、Google Gemini 的模型与 API 变更，自动生成报告推送到 Slack。

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
  有变更 → Slack #zsc-ai-news
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
| **零外部依赖** | 无需数据库，配置和数据全部存储在 Git 仓库中 |

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
├── data/
│   ├── snapshots/          # 模型列表快照（用于变更对比）
│   ├── history/            # 每日检测结果历史
│   └── weekly/             # 周报存档
├── src/
│   ├── config.ts           # 配置加载
│   ├── types.ts            # 类型定义
│   ├── fetcher-rss.ts      # RSS 抓取模块
│   ├── fetcher-api.ts      # API 模型列表抓取
│   ├── diff.ts             # 快照对比与变更检测
│   ├── llm.ts              # LLM 报告生成
│   ├── slack.ts            # Slack 推送
│   ├── storage.ts          # 历史记录存储
│   ├── run-daily.ts        # 每日检测入口
│   └── run-weekly.ts       # 每周总结入口
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

### 环境变量（可选，用于 API 模型列表抓取）

| 变量名 | 说明 |
| :--- | :--- |
| `OPENAI_OFFICIAL_API_KEY` | OpenAI API Key（用于获取模型列表） |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `GOOGLE_AI_API_KEY` | Google AI API Key |

> 注：即使没有 API Key，系统仍会通过 RSS 监控博客更新。API Key 用于更精确地检测模型列表变化。

### 手动运行

```bash
# 每日检测（dry-run 模式，不发送 Slack）
pnpm daily -- --dry-run

# 每日检测（正式模式，发送 Slack）
pnpm daily

# 每周总结
pnpm weekly
```

---

## 定时调度

在 Manus 中配置两个定时任务：

1. **每日检测**：每天早上 9:00（Cron: `0 0 9 * * *`）
   ```bash
   cd /home/ubuntu/ai-news && pnpm daily
   ```

2. **每周总结**：每周五晚上 20:00（Cron: `0 0 20 * * 5`）
   ```bash
   cd /home/ubuntu/ai-news && pnpm weekly
   ```

---

## 技术栈

| 组件 | 技术 |
| :--- | :--- |
| 运行时 | Node.js 22 + TypeScript |
| RSS 解析 | `rss-parser` |
| LLM 调用 | OpenAI SDK（兼容接口） |
| Slack 推送 | Manus MCP Slack 连接器 |
| 存储 | JSON 文件（Git 版本控制） |
| 定时调度 | Manus Schedule |

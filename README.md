# AI Information Filter — 个人信息聚合与筛选系统

> 一套围绕自己运转的**漏斗式信息处理工作流**：广泛捕捉 → 多层去重 → AI精选 → Notion沉淀 → 反馈优化。

---

## 系统架构

```
Notion 信息源配置表
        │
        ▼
  RSS 抓取（并发）
        │
        ▼
  URL 精确去重 ──── 过滤已存在的 URL（7天内）
        │
        ▼
  相似度去重 ──────── TF-IDF 余弦相似度，过滤同事件多篇报道
        │
        ▼
  LLM Digest ──────── 批量生成摘要、质量评分(0-10)、分类
        │
        ▼
  MySQL 数据库存储
        │
        ▼
  Rerank 排序 ──────── 应用个人画像权重（信息源/分类/关键词）
        │
        ▼
  LLM Daily Review ─── 跨源去重 + 栏目分类 + 最终精选(≤30篇)
        │
        ▼
  写入 Notion 文章库
        │
        ▼
  您在 Notion 中阅读 → 标记 👍/👎/标签
        │
        ▼
  下次运行时读取反馈 → 更新个人画像权重（闭环）
```

---

## 功能特性

| 功能 | 说明 |
| :--- | :--- |
| **可配置信息源** | 在 Notion 表格中管理 RSS 订阅，随时增删改 |
| **三层去重** | URL精确去重 + 相似度去重 + LLM跨源去重 |
| **AI摘要与评分** | 每篇文章自动生成中文摘要和质量评分(0-10) |
| **结构化日报** | 按"今日要闻/产品应用/开发者工具/安全风险/深度阅读"分栏 |
| **反馈闭环** | 您在Notion标记👍/👎，系统自动学习您的偏好 |
| **个人画像** | 基于反馈调整信息源/分类/关键词权重，避免信息茧房 |
| **定时调度** | 工作日(周一至周五)每晚8点自动运行，无需手动触发 |

---

## 快速开始

### 前置准备

在开始之前，您需要准备以下账号和配置：

**1. Notion Integration Token**

前往 [Notion Integrations](https://www.notion.so/my-integrations) 创建一个新的 Integration，获取 `Internal Integration Token`（以 `secret_` 开头）。

**2. 在 Notion 中创建两个数据库**

**数据库一：信息源配置表（Sources）**

| 属性名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `Name` | Title | 信息源名称，如"HackerNews" |
| `URL` | URL | RSS 地址 |
| `Category` | Select | 分类（可选） |
| `Enabled` | Checkbox | 是否启用，勾选表示启用 |

示例数据：

| Name | URL | Enabled |
| :--- | :--- | :--- |
| HackerNews | `https://news.ycombinator.com/rss` | ✅ |
| AI News | `https://buttondown.com/ainews/rss` | ✅ |
| The Batch | `https://www.deeplearning.ai/the-batch/feed/` | ✅ |
| Towards Data Science | `https://towardsdatascience.com/feed` | ✅ |

**数据库二：文章库（Articles）**

| 属性名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `Title` | Title | 文章标题（系统自动填写） |
| `URL` | URL | 文章链接（系统自动填写） |
| `Source` | Select | 信息源名称（系统自动填写） |
| `Summary` | Rich Text | AI摘要（系统自动填写） |
| `Category` | Select | 分类（系统自动填写） |
| `Quality Score` | Number | 质量评分（系统自动填写） |
| `Status` | Select | **您的核心交互字段**，选项：`📥 待阅读` / `👍 喜欢` / `👎 不喜欢` |
| `Tags` | Multi-select | 您手动添加的自定义标签 |
| `Published At` | Date | 发布时间（系统自动填写） |

**3. 将 Integration 连接到两个数据库**

在每个数据库页面右上角点击 `...` → `Connections` → 添加您刚创建的 Integration。

**4. 获取数据库 ID**

打开数据库页面，URL 格式为：
```
https://www.notion.so/{workspace}/{DATABASE_ID}?v=...
```
复制 `DATABASE_ID` 部分（32位字符串）。

---

### 环境变量配置

在 Manus 项目的 Secrets 管理中，添加以下环境变量：

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `NOTION_TOKEN` | Notion Integration Token | `secret_xxxxxxxx` |
| `NOTION_SOURCES_DB_ID` | 信息源配置表的数据库 ID | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `NOTION_ARTICLES_DB_ID` | 文章库的数据库 ID | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |

> 系统内置的 `BUILT_IN_FORGE_API_KEY` 和 `BUILT_IN_FORGE_API_URL` 已由 Manus 平台自动注入，无需手动配置。

---

### 在 Manus 中配置定时调度

在 Manus 对话框中，向 AI 发送以下指令：

```
请帮我配置一个定时任务：
- 在工作日（周一至周五）每晚 20:00 执行
- 执行命令：cd /home/ubuntu/ai_information_filter && pnpm pipeline
- 任务名称：AI Information Filter Daily Pipeline
```

Manus 会使用 Cron 表达式 `0 0 20 * * 1-5` 设置定时任务，每个工作日晚上8点自动运行整个信息处理流水线。

---

### 手动运行（测试）

```bash
cd /home/ubuntu/ai_information_filter
pnpm pipeline
```

---

## 项目结构

```
ai_information_filter/
├── server/
│   ├── pipeline/
│   │   ├── index.ts          # 流水线主入口（串联所有步骤）
│   │   ├── notion.ts         # Notion API 集成（读信息源/写文章/读反馈）
│   │   ├── fetcher.ts        # RSS 抓取 + URL去重 + 相似度去重
│   │   ├── digest.ts         # LLM Digest 预处理（摘要/评分/分类）
│   │   ├── daily-review.ts   # LLM Daily Review 精选（跨源去重/栏目分类）
│   │   ├── rerank.ts         # 个人画像 Rerank（反馈→权重→排序）
│   │   ├── db-ops.ts         # 数据库操作封装
│   │   └── pipeline.test.ts  # 单元测试
│   ├── _core/                # 框架核心（LLM/Auth/Notification等）
│   ├── db.ts                 # 数据库连接
│   └── routers.ts            # tRPC 路由
├── drizzle/
│   └── schema.ts             # 数据库 Schema（articles/pipeline_runs/profile_weights）
├── run-pipeline.mjs          # 定时任务执行入口
├── package.json
└── README.md
```

---

## 数据库表说明

| 表名 | 用途 |
| :--- | :--- |
| `articles` | 存储所有抓取和处理过的文章，用于URL去重和历史记录 |
| `pipeline_runs` | 记录每次流水线运行的统计数据和状态 |
| `profile_weights` | 存储个人画像权重（信息源/分类/关键词的偏好权重） |

---

## 个人画像权重机制

系统通过以下方式学习您的偏好：

**正反馈（👍 喜欢）**：提升该文章的信息源、分类和标签的权重。

**负反馈（👎 不喜欢）**：降低该文章的信息源、分类和标签的权重。

权重公式：
```
weight = 1.0 + (正反馈次数 - 负反馈次数) / (总反馈次数 + 10) × 0.5
```

权重范围被限制在 `[0.5, 1.5]`，避免极端值导致信息茧房。

---

## 常见问题

**Q：为什么没有文章被写入 Notion？**

检查以下几点：
1. `NOTION_TOKEN` 是否正确，且 Integration 已连接到两个数据库
2. 数据库属性名是否与文档中完全一致（区分大小写）
3. 查看运行日志中的错误信息

**Q：如何添加新的信息源？**

直接在 Notion 信息源配置表中添加新行，勾选 `Enabled` 即可。下次定时任务运行时会自动包含新来源。

**Q：如何暂停某个信息源？**

在 Notion 信息源配置表中取消勾选该行的 `Enabled` 复选框。

**Q：反馈多久才能影响推荐？**

每次定时任务运行时都会读取最新的反馈数据并更新权重，因此您的反馈会在下一次运行（最晚第二天晚上8点）时生效。

---

## 技术栈

| 组件 | 技术 |
| :--- | :--- |
| 运行时 | Node.js 22 + TypeScript |
| RSS 解析 | `rss-parser` |
| 相似度计算 | `natural` (TF-IDF) |
| Notion 集成 | `@notionhq/client` v5 |
| LLM 调用 | Manus 内置 LLM API (`BUILT_IN_FORGE_API_KEY`) |
| 数据库 | MySQL (Manus 托管) + Drizzle ORM |
| 定时调度 | Manus `schedule` 工具 |
| 测试 | Vitest |

---

## 迁移到新的 Manus 账号

如果您需要在新的 Manus 账号中重新部署此系统，请按以下步骤操作：

1. **克隆代码**：`git clone <本仓库地址>`
2. **初始化项目**：在 Manus 中使用 `web-db-user` 模板初始化同名项目
3. **安装依赖**：`pnpm install`
4. **创建数据库表**：执行 `drizzle/` 目录下的 SQL 迁移文件
5. **配置环境变量**：在 Manus Secrets 中添加 `NOTION_TOKEN`、`NOTION_SOURCES_DB_ID`、`NOTION_ARTICLES_DB_ID`
6. **配置定时调度**：参考上方"在 Manus 中配置定时调度"章节
7. **测试运行**：`pnpm pipeline`

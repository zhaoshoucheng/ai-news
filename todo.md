# AI Information Filter - TODO

## 核心功能

- [x] 数据库Schema设计（文章、反馈、画像权重表）
- [x] Notion API集成模块（读取信息源、写入文章、读取反馈）
- [x] RSS抓取模块（支持标准RSS/Atom格式）
- [x] URL精确去重模块
- [x] 相似内容去重模块（基于标题语义相似度）
- [x] LLM Digest预处理模块（摘要生成、质量评估、初步排序）
- [x] LLM Daily Review精选模块（分类提炼、去重、生成结构化日报）
- [x] 将精选内容写入Notion数据库
- [x] 从Notion读取用户反馈（喜欢/不喜欢/标签）
- [x] 个人画像rerank机制（基于反馈调整权重）
- [x] 主入口脚本（pipeline串联）
- [x] 完整部署文档（README.md）
- [x] 推送到GitHub
- [x] 实现Slack通知模块（流水线完成后发送每日摘要到Slack频道）
- [x] 在流水线主入口集成Slack通知
- [x] 推送代码到GitHub（zhaoshoucheng/ai-news）
- [x] 配置Manus定时调度（工作日每晚8点）
- [x] 自动创建Notion文章库的所有必要字段（Title/URL/Source/Summary/Category/Quality Score/Status/Tags/Published At）
- [x] 修复RSS抓取时间窗口，限制为最近 36 小时内的新文章，避免抓取历史存量数据
- [x] 去掉流水线中的邮件通知（notifyOwner），只保留Slack通知

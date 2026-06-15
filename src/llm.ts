/**
 * LLM 调用模块
 * 使用 OpenAI 兼容接口生成变更报告
 */

import OpenAI from "openai";

const client = new OpenAI();

/**
 * 调用 LLM 生成文本
 */
export async function invokeLLM(params: {
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
}): Promise<string> {
  const { systemPrompt, userPrompt, jsonMode } = params;

  const response = await client.chat.completions.create({
    model: "gemini-2.5-flash",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 16384,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  return response.choices?.[0]?.message?.content ?? "";
}

/**
 * 生成每日变更报告摘要
 */
export async function generateDailyReport(
  changesJson: string
): Promise<string> {
  const systemPrompt = `你是一位专业的 AI 技术分析师，专注于跟踪 OpenAI、Anthropic 和 Google Gemini 的模型与 API 变更。
你的任务是将检测到的变更信息整理成一份简洁、专业的中文报告，面向需要适配这些 API 的开发者。

报告要求：
1. 使用 Markdown 格式（适合邮件展示）
2. 突出重点排序：新模型发布 > 参数变更 > API 变更 > 行业新闻 > 博客更新
3. **每一条数据（每篇文章 / 每个变更）都必须单独成条，并给出一段简短但抓重点的总结**：
   - 长度控制在 2-4 句话（约 50-120 字），不要只写一句话，也不要冗长
   - 必须概括这条内容的核心要点：发生了什么、关键的数字 / 参数 / 名称、对开发者意味着什么
   - 不能只是复述标题，要提炼文章 / 变更的实质内容
4. 对于新模型，要对比与同系列旧模型的差异（如 context window、价格、能力）
5. 对于参数 / API 变更，要明确标注变化前后的值或新增 / 废弃的接口
6. 每条总结的格式建议为：
   **<标题>**
   <2-4 句的重点总结>
   🔗 <URL>
7. 每条变更或新闻后附上原文链接（从数据中的 url 字段获取），格式为：🔗 <URL>
8. 语言简洁专业，避免空话套话`;

  const userPrompt = `以下是今日检测到的 AI 模型变更数据（JSON 格式）：

${changesJson}

请生成一份结构化的每日变更报告，**对每一条数据都生成一段有重点的简短总结**（2-4 句话），按厂商或类型分类整理。即使是博客或行业新闻，也要总结其重点内容，而不是仅列出标题。`;

  return invokeLLM({ systemPrompt, userPrompt });
}

/**
 * 生成每周总结报告
 */
export async function generateWeeklyReport(
  weeklyDataJson: string
): Promise<string> {
  const systemPrompt = `你是一位专业的 AI 技术分析师，负责撰写每周 AI 模型变更总结报告。
你的读者是需要适配 OpenAI、Anthropic、Google Gemini API 的开发者。

周报要求：
1. 使用 Markdown 格式
2. 开头有本周概览（一段话总结本周最重要的变化）
3. 按厂商分类整理本周所有变更
4. 对重要变更给出详细分析和开发者建议
5. 末尾有"下周关注"板块（基于趋势预测可能的变化）
6. 语言专业但易读，适合快速浏览`;

  const userPrompt = `以下是本周（周一到周五）每日检测到的变更数据汇总：

${weeklyDataJson}

请生成一份完整的周报。如果某天没有变更，可以跳过。重点关注：
- 新模型发布及其与旧模型的对比
- API 接口变更对开发者的影响
- 定价变化
- 重要的官方博客公告`;

  return invokeLLM({ systemPrompt, userPrompt });
}

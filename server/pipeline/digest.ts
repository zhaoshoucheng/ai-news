/**
 * LLM Digest 预处理模块
 *
 * 职责：
 * 对去重后的原始文章进行批量处理：
 * 1. 生成 AI 摘要
 * 2. 质量评分（0-10）
 * 3. 内容分类
 * 4. 初步排序
 *
 * 采用批处理方式，每批 10 篇，减少 API 调用次数
 */

import { invokeLLM } from "../_core/llm";
import type { RawArticle } from "./fetcher";

export interface DigestedArticle extends RawArticle {
  aiSummary: string;
  qualityScore: number;
  category: string;
}

const BATCH_SIZE = 10;

// 预定义分类列表，保持一致性
const CATEGORIES = [
  "AI模型与研究",
  "AI应用与产品",
  "AI工具与开发",
  "开源项目",
  "行业动态",
  "安全与风险",
  "技术教程",
  "商业与投资",
  "其他",
];

/**
 * 批量处理文章，生成摘要、评分和分类
 */
export async function digestArticles(rawArticles: RawArticle[]): Promise<DigestedArticle[]> {
  if (rawArticles.length === 0) return [];

  const results: DigestedArticle[] = [];
  const batches = chunkArray(rawArticles, BATCH_SIZE);

  console.log(
    `[Digest] Processing ${rawArticles.length} articles in ${batches.length} batches...`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[Digest] Processing batch ${i + 1}/${batches.length} (${batch.length} articles)`);

    try {
      const batchResults = await processBatch(batch);
      results.push(...batchResults);
    } catch (err: any) {
      console.error(`[Digest] Batch ${i + 1} failed: ${err.message}`);
      // 降级处理：使用原始摘要，给予中等分数
      for (const article of batch) {
        results.push({
          ...article,
          aiSummary: article.rawSummary ?? "摘要生成失败",
          qualityScore: 5.0,
          category: "其他",
        });
      }
    }

    // 避免 API 限速，批次间稍作等待
    if (i < batches.length - 1) {
      await sleep(1000);
    }
  }

  // 按质量分降序排列
  results.sort((a, b) => b.qualityScore - a.qualityScore);

  console.log(`[Digest] Completed. Average quality score: ${
    (results.reduce((s, a) => s + a.qualityScore, 0) / results.length).toFixed(2)
  }`);

  return results;
}

async function processBatch(batch: RawArticle[]): Promise<DigestedArticle[]> {
  const articlesJson = batch.map((a, idx) => ({
    id: idx,
    title: a.title,
    source: a.sourceName,
    snippet: a.rawSummary?.slice(0, 300) ?? "",
  }));

  const prompt = `你是一个专业的AI和技术信息分析师。请对以下文章列表进行分析，为每篇文章生成中文摘要、质量评分和分类。

文章列表：
${JSON.stringify(articlesJson, null, 2)}

分类选项（必须从以下选项中选择）：
${CATEGORIES.join("、")}

质量评分标准（0-10分）：
- 9-10分：深度原创研究、重大技术突破、高质量教程
- 7-8分：有实质内容的技术文章、重要产品发布、有价值的分析
- 5-6分：普通资讯、一般性介绍文章
- 3-4分：标题党、内容空洞、营销软文
- 1-2分：重复报道、无实质内容、广告

请以 JSON 数组格式返回，每个元素包含：
- id: 原文章的id
- summary: 50-100字的中文摘要，突出核心价值点
- qualityScore: 质量评分（数字，保留一位小数）
- category: 分类（必须从上述选项中选择）`;

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "你是专业的技术信息分析师，擅长评估AI和技术内容的质量。请严格按照JSON格式返回结果，不要添加任何额外文字。",
      },
      { role: "user", content: prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "digest_results",
        strict: true,
        schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  summary: { type: "string" },
                  qualityScore: { type: "number" },
                  category: { type: "string" },
                },
                required: ["id", "summary", "qualityScore", "category"],
                additionalProperties: false,
              },
            },
          },
          required: ["results"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  const llmResults: Array<{
    id: number;
    summary: string;
    qualityScore: number;
    category: string;
  }> = parsed.results ?? [];

  // 将 LLM 结果映射回原始文章
  return batch.map((article, idx) => {
    const llmResult = llmResults.find((r) => r.id === idx);
    return {
      ...article,
      aiSummary: llmResult?.summary ?? article.rawSummary ?? "",
      qualityScore: clamp(llmResult?.qualityScore ?? 5.0, 0, 10),
      category: CATEGORIES.includes(llmResult?.category ?? "")
        ? (llmResult?.category ?? "其他")
        : "其他",
    };
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

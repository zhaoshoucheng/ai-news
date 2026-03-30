/**
 * Daily Review 精选模块
 *
 * 职责：
 * 从 rerank 后的文章中进行最终精选：
 * 1. 过滤低质量文章（qualityScore < 5）
 * 2. 使用 LLM 对候选文章进行跨源去重（同一事件多篇报道合并）
 * 3. 按固定栏目分类，生成结构化日报
 * 4. 控制最终输出数量（默认 20-30 篇）
 */

import { invokeLLM } from "../_core/llm";
import type { RankedArticle } from "./rerank";

export interface ReviewArticle {
  url: string;
  title: string;
  sourceName: string;
  aiSummary: string;
  category: string;
  qualityScore: number;
  rankScore: number;
  publishedAt?: Date;
}

export interface DailyReview {
  date: string;
  totalCandidates: number;
  sections: ReviewSection[];
  articles: ReviewArticle[];
}

export interface ReviewSection {
  name: string;
  emoji: string;
  articles: ReviewArticle[];
}

// 日报栏目定义
const REVIEW_SECTIONS = [
  { name: "今日要闻", emoji: "🔥", categories: ["AI模型与研究", "行业动态"] },
  { name: "产品与应用", emoji: "🚀", categories: ["AI应用与产品"] },
  { name: "开发者工具", emoji: "🛠️", categories: ["AI工具与开发", "开源项目"] },
  { name: "安全与风险", emoji: "⚠️", categories: ["安全与风险"] },
  { name: "深度阅读", emoji: "📖", categories: ["技术教程", "商业与投资"] },
  { name: "其他", emoji: "📌", categories: ["其他"] },
];

const MAX_REVIEW_ARTICLES = 30;
const MIN_QUALITY_SCORE = 4.5;

/**
 * 生成每日精选报告
 */
export async function generateDailyReview(
  rankedArticles: RankedArticle[]
): Promise<{ selected: ReviewArticle[]; review: DailyReview }> {
  // 第一步：过滤低质量文章
  const candidates = rankedArticles.filter((a) => a.qualityScore >= MIN_QUALITY_SCORE);
  console.log(
    `[DailyReview] Quality filter: ${rankedArticles.length} → ${candidates.length} (min score: ${MIN_QUALITY_SCORE})`
  );

  if (candidates.length === 0) {
    return {
      selected: [],
      review: buildEmptyReview(rankedArticles.length),
    };
  }

  // 第二步：使用 LLM 进行跨源去重和最终精选
  const selected = await llmSelectAndDeduplicate(candidates);
  console.log(`[DailyReview] LLM selection: ${candidates.length} → ${selected.length}`);

  // 第三步：构建结构化日报
  const review = buildReview(selected, rankedArticles.length);

  return { selected, review };
}

/**
 * 使用 LLM 进行跨源去重和精选
 * 核心任务：
 * 1. 识别同一事件的多篇报道，只保留最具代表性的一篇
 * 2. 从剩余文章中选出最有价值的 MAX_REVIEW_ARTICLES 篇
 */
async function llmSelectAndDeduplicate(
  candidates: RankedArticle[]
): Promise<ReviewArticle[]> {
  // 如果候选文章数量较少，直接返回
  if (candidates.length <= MAX_REVIEW_ARTICLES) {
    return candidates.map(toReviewArticle);
  }

  // 取前 60 篇（rankScore 最高的）送给 LLM 精选，避免 token 超限
  const topCandidates = candidates.slice(0, 60);

  const articleList = topCandidates.map((a, idx) => ({
    id: idx,
    title: a.title,
    source: a.sourceName,
    category: a.category,
    score: a.rankScore,
    summary: a.aiSummary.slice(0, 150),
  }));

  const prompt = `你是一位专业的AI技术信息编辑。请从以下候选文章中进行精选，目标是为读者提供一份高质量的每日信息报告。

候选文章（共${articleList.length}篇，已按相关性排序）：
${JSON.stringify(articleList, null, 2)}

精选要求：
1. **去重优先**：如果多篇文章报道同一事件或主题（如"OpenAI发布GPT-5"有多篇报道），只保留最具代表性的1篇（通常是分数最高的）
2. **多样性**：确保不同分类的文章都有代表，避免某一类型文章占比过高
3. **数量控制**：最终选出 ${MAX_REVIEW_ARTICLES} 篇左右（不超过${MAX_REVIEW_ARTICLES}篇）
4. **质量优先**：在满足多样性的前提下，优先选择分数高、内容深度好的文章

请返回被选中文章的 id 列表（JSON数组格式）。`;

  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "你是专业的技术信息编辑，擅长识别重复内容和筛选高价值信息。请严格按JSON格式返回。",
        },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "selection_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              selectedIds: {
                type: "array",
                items: { type: "integer" },
              },
            },
            required: ["selectedIds"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
    const selectedIds: number[] = parsed.selectedIds ?? [];

    const selectedSet = new Set(selectedIds);
    return topCandidates
      .filter((_, idx) => selectedSet.has(idx))
      .slice(0, MAX_REVIEW_ARTICLES)
      .map(toReviewArticle);
  } catch (err: any) {
    console.error(`[DailyReview] LLM selection failed: ${err.message}, falling back to top-N`);
    return topCandidates.slice(0, MAX_REVIEW_ARTICLES).map(toReviewArticle);
  }
}

/**
 * 构建结构化日报对象
 */
function buildReview(selected: ReviewArticle[], totalCandidates: number): DailyReview {
  const today = new Date().toISOString().split("T")[0];

  const sections: ReviewSection[] = REVIEW_SECTIONS.map((sectionDef) => {
    const sectionArticles = selected.filter((a) =>
      sectionDef.categories.includes(a.category)
    );
    return {
      name: sectionDef.name,
      emoji: sectionDef.emoji,
      articles: sectionArticles,
    };
  }).filter((s) => s.articles.length > 0);

  return {
    date: today,
    totalCandidates,
    sections,
    articles: selected,
  };
}

function buildEmptyReview(totalCandidates: number): DailyReview {
  return {
    date: new Date().toISOString().split("T")[0],
    totalCandidates,
    sections: [],
    articles: [],
  };
}

function toReviewArticle(a: RankedArticle): ReviewArticle {
  return {
    url: a.url,
    title: a.title,
    sourceName: a.sourceName,
    aiSummary: a.aiSummary,
    category: a.category,
    qualityScore: a.qualityScore,
    rankScore: a.rankScore,
    publishedAt: a.publishedAt,
  };
}

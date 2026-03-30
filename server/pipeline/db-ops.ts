/**
 * 数据库操作模块
 *
 * 封装所有与 articles、pipelineRuns 表的交互
 */

import { eq, and, gte } from "drizzle-orm";
import { getDb } from "../db";
import { articles, pipelineRuns } from "../../drizzle/schema";
import type { DigestedArticle } from "./digest";
import type { RankedArticle } from "./rerank";
import type { ReviewArticle } from "./daily-review";

/**
 * 批量插入文章到数据库
 * 忽略已存在的 URL（ON DUPLICATE KEY IGNORE）
 */
export async function saveArticlesToDb(
  digestedArticles: DigestedArticle[]
): Promise<void> {
  const db = await getDb();
  if (!db || digestedArticles.length === 0) return;

  // 分批插入，每批 50 条
  const batches = chunkArray(digestedArticles, 50);
  for (const batch of batches) {
    try {
      await db
        .insert(articles)
        .values(
          batch.map((a) => ({
            url: a.url,
            title: a.title,
            sourceName: a.sourceName,
            sourceUrl: a.sourceUrl,
            publishedAt: a.publishedAt,
            rawSummary: a.rawSummary,
            aiSummary: a.aiSummary,
            qualityScore: a.qualityScore,
            category: a.category,
            rankScore: 0,
          }))
        )
        .onDuplicateKeyUpdate({ set: { aiSummary: articles.aiSummary as any } });
    } catch (err: any) {
      console.error("[DbOps] Failed to save articles batch:", err.message);
    }
  }
}

/**
 * 更新文章的 rankScore 和 selectedForReview 标记
 */
export async function updateArticleRankScores(
  rankedArticles: RankedArticle[],
  selectedUrls: Set<string>
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  for (const article of rankedArticles) {
    try {
      await db
        .update(articles)
        .set({
          rankScore: article.rankScore,
          selectedForReview: selectedUrls.has(article.url) ? 1 : 0,
        })
        .where(eq(articles.url, article.url));
    } catch (err: any) {
      console.error(`[DbOps] Failed to update rank for ${article.url}:`, err.message);
    }
  }
}

/**
 * 更新文章的 Notion Page ID
 */
export async function updateNotionPageIds(
  urlToPageId: Map<string, string>
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  for (const [url, pageId] of Array.from(urlToPageId.entries())) {
    try {
      await db
        .update(articles)
        .set({ writtenToNotion: 1, notionPageId: pageId })
        .where(eq(articles.url, url));
    } catch (err: any) {
      console.error(`[DbOps] Failed to update notion page id for ${url}:`, err.message);
    }
  }
}

/**
 * 创建流水线运行记录
 */
export async function createPipelineRun(): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const result = await db.insert(pipelineRuns).values({
      status: "running",
      startedAt: new Date(),
    });
    return (result as any).insertId ?? null;
  } catch (err: any) {
    console.error("[DbOps] Failed to create pipeline run:", err.message);
    return null;
  }
}

/**
 * 更新流水线运行记录
 */
export async function updatePipelineRun(
  runId: number,
  data: {
    status: "success" | "failed";
    fetchedCount?: number;
    afterUrlDedup?: number;
    afterSimilarDedup?: number;
    digestCount?: number;
    reviewCount?: number;
    errorMessage?: string;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    await db
      .update(pipelineRuns)
      .set({
        ...data,
        finishedAt: new Date(),
      })
      .where(eq(pipelineRuns.id, runId));
  } catch (err: any) {
    console.error("[DbOps] Failed to update pipeline run:", err.message);
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

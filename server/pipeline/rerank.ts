/**
 * 个人画像 Rerank 模块
 *
 * 职责：
 * 1. 从数据库读取个人画像权重
 * 2. 基于用户反馈数据更新权重
 * 3. 对 Digest 后的文章进行 rerank 排序
 *
 * 设计原则：
 * - 轻量引导，避免信息茧房
 * - 权重影响有上限，保留对重要公共信息的关注
 * - 正负反馈均衡考虑
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "../db";
import { profileWeights } from "../../drizzle/schema";
import type { NotionFeedback } from "./notion";
import type { DigestedArticle } from "./digest";

export interface RankedArticle extends DigestedArticle {
  rankScore: number;
}

/**
 * 从 Notion 反馈更新个人画像权重
 */
export async function updateProfileFromFeedback(feedbacks: NotionFeedback[]): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Rerank] Database not available, skipping profile update");
    return;
  }

  if (feedbacks.length === 0) {
    console.log("[Rerank] No feedback to process");
    return;
  }

  console.log(`[Rerank] Processing ${feedbacks.length} feedback items...`);

  for (const feedback of feedbacks) {
    const isPositive = feedback.status === "liked";
    const delta = isPositive ? 1 : -1;

    // 更新信息源维度权重
    if (feedback.sourceName) {
      await upsertWeight(db, "source", feedback.sourceName, isPositive);
    }

    // 更新分类维度权重
    if (feedback.category) {
      await upsertWeight(db, "category", feedback.category, isPositive);
    }

    // 更新标签维度权重（来自用户手动打的标签）
    for (const tag of feedback.tags) {
      await upsertWeight(db, "keyword", tag, isPositive);
    }
  }

  console.log("[Rerank] Profile weights updated");
}

/**
 * 对文章列表进行 rerank 排序
 * rankScore = qualityScore * sourceWeight * categoryWeight * (1 + keywordBonus)
 */
export async function rerankArticles(articles: DigestedArticle[]): Promise<RankedArticle[]> {
  const db = await getDb();

  // 加载所有权重
  let weights: Array<{ dimensionType: string; dimensionValue: string; weight: number }> = [];
  if (db) {
    weights = await db
      .select({
        dimensionType: profileWeights.dimensionType,
        dimensionValue: profileWeights.dimensionValue,
        weight: profileWeights.weight,
      })
      .from(profileWeights);
  }

  const sourceWeights = new Map<string, number>();
  const categoryWeights = new Map<string, number>();
  const keywordWeights = new Map<string, number>();

  for (const w of weights) {
    if (w.dimensionType === "source") sourceWeights.set(w.dimensionValue, w.weight);
    else if (w.dimensionType === "category") categoryWeights.set(w.dimensionValue, w.weight);
    else if (w.dimensionType === "keyword") keywordWeights.set(w.dimensionValue, w.weight);
  }

  const ranked: RankedArticle[] = articles.map((article) => {
    // 基础分：质量分（0-10）
    let score = article.qualityScore;

    // 信息源权重乘数（0.5 ~ 1.5，避免极端值）
    const srcWeight = clamp(sourceWeights.get(article.sourceName) ?? 1.0, 0.5, 1.5);
    score *= srcWeight;

    // 分类权重乘数（0.5 ~ 1.5）
    const catWeight = clamp(categoryWeights.get(article.category) ?? 1.0, 0.5, 1.5);
    score *= catWeight;

    // 关键词加成（最多 +20%）
    let keywordBonus = 0;
    const titleLower = article.title.toLowerCase();
    for (const [keyword, kw] of Array.from(keywordWeights.entries())) {
      if (titleLower.includes(keyword.toLowerCase())) {
        keywordBonus += (kw - 1.0) * 0.1; // 每个关键词最多贡献 ±10%
      }
    }
    keywordBonus = clamp(keywordBonus, -0.2, 0.2);
    score *= 1 + keywordBonus;

    // 时效性加成：24小时内发布的文章 +5%
    if (article.publishedAt) {
      const ageHours = (Date.now() - article.publishedAt.getTime()) / 3600000;
      if (ageHours < 24) score *= 1.05;
    }

    return { ...article, rankScore: Math.round(score * 100) / 100 };
  });

  // 按 rankScore 降序排列
  ranked.sort((a, b) => b.rankScore - a.rankScore);

  return ranked;
}

/**
 * 更新或插入权重记录
 */
async function upsertWeight(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  type: "source" | "category" | "keyword",
  value: string,
  isPositive: boolean
): Promise<void> {
  try {
    const existing = await db
      .select()
      .from(profileWeights)
      .where(
        and(
          eq(profileWeights.dimensionType, type),
          eq(profileWeights.dimensionValue, value)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const current = existing[0];
      const newPositive = current.positiveCount + (isPositive ? 1 : 0);
      const newNegative = current.negativeCount + (isPositive ? 0 : 1);
      // 权重公式：1 + (positive - negative) / (positive + negative + 10) * 0.5
      // 分母+10 是平滑因子，避免样本过少时权重波动过大
      const total = newPositive + newNegative + 10;
      const newWeight = 1.0 + ((newPositive - newNegative) / total) * 0.5;

      await db
        .update(profileWeights)
        .set({
          positiveCount: newPositive,
          negativeCount: newNegative,
          weight: Math.round(newWeight * 1000) / 1000,
        })
        .where(eq(profileWeights.id, current.id));
    } else {
      const newPositive = isPositive ? 1 : 0;
      const newNegative = isPositive ? 0 : 1;
      const total = newPositive + newNegative + 10;
      const newWeight = 1.0 + ((newPositive - newNegative) / total) * 0.5;

      await db.insert(profileWeights).values({
        dimensionType: type,
        dimensionValue: value,
        positiveCount: newPositive,
        negativeCount: newNegative,
        weight: Math.round(newWeight * 1000) / 1000,
      });
    }
  } catch (err: any) {
    console.error(`[Rerank] Failed to upsert weight for ${type}:${value}`, err.message);
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

/**
 * 信息处理流水线主入口
 *
 * 完整流程：
 * 1. 读取 Notion 信息源配置
 * 2. 读取用户反馈，更新个人画像权重
 * 3. 抓取所有 RSS 信息源
 * 4. URL 精确去重
 * 5. 标题相似度去重
 * 6. LLM Digest 预处理（摘要、评分、分类）
 * 7. 保存到数据库
 * 8. Rerank 排序（应用个人画像权重）
 * 9. Daily Review 精选（LLM 跨源去重 + 栏目分类）
 * 10. 将精选内容写入 Notion
 * 11. 发送完成通知
 */

import "dotenv/config";
import { fetchSourcesFromNotion, writeArticlesToNotion, fetchFeedbackFromNotion } from "./notion";
import { fetchAllSources, deduplicateByUrl, deduplicateBySimilarity } from "./fetcher";
import { digestArticles } from "./digest";
import { rerankArticles, updateProfileFromFeedback } from "./rerank";
import { generateDailyReview } from "./daily-review";
import {
  saveArticlesToDb,
  updateArticleRankScores,
  updateNotionPageIds,
  createPipelineRun,
  updatePipelineRun,
} from "./db-ops";
import { sendSlackNotification } from "./slack-notify";
export async function runPipeline(): Promise<void> {
  const startTime = Date.now();
  console.log("\n========================================");
  console.log(`[Pipeline] Starting at ${new Date().toISOString()}`);
  console.log("========================================\n");

  const runId = await createPipelineRun();

  try {
    // ── Step 1: 读取用户反馈，优先更新个人画像 ──────────────────────
    console.log("[Pipeline] Step 1: Fetching user feedback from Notion...");
    let feedbacks = [];
    try {
      feedbacks = await fetchFeedbackFromNotion();
      console.log(`[Pipeline] Found ${feedbacks.length} feedback items`);
      await updateProfileFromFeedback(feedbacks);
    } catch (err: any) {
      console.warn(`[Pipeline] Feedback fetch failed (non-fatal): ${err.message}`);
    }

    // ── Step 2: 读取信息源配置 ──────────────────────────────────────
    console.log("\n[Pipeline] Step 2: Fetching sources from Notion...");
    const sources = await fetchSourcesFromNotion();
    if (sources.length === 0) {
      throw new Error("No sources found in Notion. Please add RSS sources to your Notion database.");
    }
    console.log(`[Pipeline] Found ${sources.length} active sources`);

    // ── Step 3: 抓取所有信息源 ──────────────────────────────────────
    console.log("\n[Pipeline] Step 3: Fetching RSS feeds...");
    const rawArticles = await fetchAllSources(sources);
    const fetchedCount = rawArticles.length;
    console.log(`[Pipeline] Fetched ${fetchedCount} raw articles`);

    if (fetchedCount === 0) {
      console.log("[Pipeline] No articles fetched, exiting early");
      if (runId) await updatePipelineRun(runId, { status: "success", fetchedCount: 0 });
      return;
    }

    // ── Step 4: URL 精确去重 ─────────────────────────────────────────
    console.log("\n[Pipeline] Step 4: URL deduplication...");
    const afterUrlDedup = await deduplicateByUrl(rawArticles);
    const urlDedupCount = afterUrlDedup.length;

    if (urlDedupCount === 0) {
      console.log("[Pipeline] All articles already exist in database, exiting");
      if (runId) {
        await updatePipelineRun(runId, {
          status: "success",
          fetchedCount,
          afterUrlDedup: 0,
        });
      }
      return;
    }

    // ── Step 5: 相似度去重 ───────────────────────────────────────────
    console.log("\n[Pipeline] Step 5: Similarity deduplication...");
    const afterSimilarDedup = deduplicateBySimilarity(afterUrlDedup);
    const similarDedupCount = afterSimilarDedup.length;

    // ── Step 6: LLM Digest 预处理 ────────────────────────────────────
    console.log("\n[Pipeline] Step 6: LLM Digest processing...");
    const digestedArticles = await digestArticles(afterSimilarDedup);
    const digestCount = digestedArticles.length;

    // ── Step 7: 保存到数据库 ─────────────────────────────────────────
    console.log("\n[Pipeline] Step 7: Saving to database...");
    await saveArticlesToDb(digestedArticles);

    // ── Step 8: Rerank 排序 ──────────────────────────────────────────
    console.log("\n[Pipeline] Step 8: Reranking articles...");
    const rankedArticles = await rerankArticles(digestedArticles);

    // ── Step 9: Daily Review 精选 ────────────────────────────────────
    console.log("\n[Pipeline] Step 9: Generating Daily Review...");
    const { selected, review } = await generateDailyReview(rankedArticles);
    const reviewCount = selected.length;

    // 更新数据库中的 rankScore 和 selectedForReview
    const selectedUrls = new Set(selected.map((a) => a.url));
    await updateArticleRankScores(rankedArticles, selectedUrls);

    // ── Step 10: 写入 Notion ─────────────────────────────────────────
    console.log("\n[Pipeline] Step 10: Writing to Notion...");
    if (selected.length > 0) {
      const urlToPageId = await writeArticlesToNotion(
        selected.map((a) => ({
          title: a.title,
          url: a.url,
          sourceName: a.sourceName,
          summary: a.aiSummary,
          category: a.category,
          qualityScore: a.qualityScore,
          publishedAt: a.publishedAt,
        }))
      );
      await updateNotionPageIds(urlToPageId);
      console.log(`[Pipeline] Written ${urlToPageId.size} articles to Notion`);
    }

    // ── Step 11: 更新运行记录 & 发送通知 ────────────────────────────
    if (runId) {
      await updatePipelineRun(runId, {
        status: "success",
        fetchedCount,
        afterUrlDedup: urlDedupCount,
        afterSimilarDedup: similarDedupCount,
        digestCount,
        reviewCount,
      });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const pipelineStats = {
      fetchedCount,
      urlDedupCount,
      similarDedupCount,
      digestCount,
      reviewCount,
      elapsed,
    };
    const summary = buildSummary(review, pipelineStats);

    console.log("\n" + summary);

    // 发送 Slack 通知
    await sendSlackNotification(review, pipelineStats);
  } catch (err: any) {
    console.error("\n[Pipeline] FATAL ERROR:", err.message);
    if (runId) {
      await updatePipelineRun(runId, {
        status: "failed",
        errorMessage: err.message,
      });
    }
    throw err;
  }
}

function buildSummary(
  review: any,
  stats: {
    fetchedCount: number;
    urlDedupCount: number;
    similarDedupCount: number;
    digestCount: number;
    reviewCount: number;
    elapsed: string;
  }
): string {
  const lines = [
    `========================================`,
    `📰 每日信息报告 - ${review.date}`,
    `========================================`,
    ``,
    `📊 处理统计：`,
    `  抓取原始文章：${stats.fetchedCount} 篇`,
    `  URL去重后：${stats.urlDedupCount} 篇`,
    `  相似度去重后：${stats.similarDedupCount} 篇`,
    `  Digest处理后：${stats.digestCount} 篇`,
    `  最终精选：${stats.reviewCount} 篇`,
    `  耗时：${stats.elapsed}s`,
    ``,
  ];

  if (review.sections && review.sections.length > 0) {
    lines.push(`📋 今日栏目：`);
    for (const section of review.sections) {
      lines.push(`  ${section.emoji} ${section.name}：${section.articles.length} 篇`);
    }
  }

  lines.push(``, `✅ 已写入 Notion，请前往查看。`);
  lines.push(`========================================`);

  return lines.join("\n");
}

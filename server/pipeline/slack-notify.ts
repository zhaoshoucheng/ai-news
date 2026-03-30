/**
 * Slack 通知模块
 *
 * 在每日信息报告生成完成后，向指定 Slack 频道发送摘要通知。
 * 使用 Slack Incoming Webhook，无需 OAuth，配置简单稳定。
 *
 * 环境变量：
 * - SLACK_WEBHOOK_URL: Slack Incoming Webhook URL
 *   格式：https://hooks.slack.com/services/xxx/xxx/xxx
 *   获取方式：https://api.slack.com/apps → Incoming Webhooks
 */

import type { DailyReview } from "./daily-review";

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text: string }>;
  fields?: Array<{ type: string; text: string }>;
  accessory?: Record<string, unknown>;
}

/**
 * 流水线完成后发送 Slack 通知
 */
export async function sendSlackNotification(
  review: DailyReview,
  stats: {
    fetchedCount: number;
    urlDedupCount: number;
    similarDedupCount: number;
    digestCount: number;
    reviewCount: number;
    elapsed: string;
  }
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[Slack] SLACK_WEBHOOK_URL not set, skipping notification");
    return;
  }

  const payload = buildSlackPayload(review, stats);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Slack API returned ${response.status}: ${body}`);
    }

    console.log("[Slack] Notification sent successfully");
  } catch (err: any) {
    // 通知失败不应中断主流程
    console.error(`[Slack] Failed to send notification: ${err.message}`);
  }
}

/**
 * 构建 Slack Block Kit 消息体
 * 使用 Block Kit 格式，让消息更美观易读
 */
function buildSlackPayload(
  review: DailyReview,
  stats: {
    fetchedCount: number;
    urlDedupCount: number;
    similarDedupCount: number;
    digestCount: number;
    reviewCount: number;
    elapsed: string;
  }
): Record<string, unknown> {
  const blocks: SlackBlock[] = [];

  // ── 标题区 ──────────────────────────────────────────────────────
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `📰 每日 AI 信息报告 · ${review.date}`,
      emoji: true,
    },
  });

  // ── 处理统计 ─────────────────────────────────────────────────────
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*抓取原始文章*\n${stats.fetchedCount} 篇` },
      { type: "mrkdwn", text: `*去重后候选*\n${stats.similarDedupCount} 篇` },
      { type: "mrkdwn", text: `*AI精选入库*\n${stats.reviewCount} 篇` },
      { type: "mrkdwn", text: `*处理耗时*\n${stats.elapsed}s` },
    ],
  });

  blocks.push({ type: "divider" });

  // ── 栏目摘要 ─────────────────────────────────────────────────────
  if (review.sections && review.sections.length > 0) {
    const sectionLines = review.sections
      .map((s) => `${s.emoji} *${s.name}*：${s.articles.length} 篇`)
      .join("\n");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*今日栏目*\n${sectionLines}`,
      },
    });

    blocks.push({ type: "divider" });
  }

  // ── 精选文章预览（最多展示5篇高分文章）──────────────────────────
  const topArticles = review.articles
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 5);

  if (topArticles.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🔥 今日精选 Top 5*",
      },
    });

    for (const article of topArticles) {
      const scoreBar = "★".repeat(Math.round(article.qualityScore / 2)) +
        "☆".repeat(5 - Math.round(article.qualityScore / 2));
      const summary = article.aiSummary.slice(0, 100) +
        (article.aiSummary.length > 100 ? "…" : "");

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${article.url}|${escapeSlack(article.title)}>*\n${escapeSlack(summary)}\n_${article.sourceName} · ${article.category} · ${scoreBar}_`,
        },
      });
    }

    blocks.push({ type: "divider" });
  }

  // ── 底部行动号召 ─────────────────────────────────────────────────
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `✅ 完整报告已写入 Notion，请前往查看并标记 *👍 喜欢* 或 *👎 不喜欢* 以优化明日推荐。`,
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `_由 AI Information Filter 自动生成 · ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}_`,
      },
    ],
  });

  return {
    blocks,
    // fallback text for notifications
    text: `📰 每日 AI 信息报告 (${review.date}) — 精选 ${stats.reviewCount} 篇，已写入 Notion`,
  };
}

/**
 * 转义 Slack mrkdwn 中的特殊字符
 */
function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

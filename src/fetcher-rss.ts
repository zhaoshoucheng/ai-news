/**
 * RSS 抓取模块
 * 从各厂商官方博客/changelog RSS 获取最新文章
 */

import Parser from "rss-parser";
import type { ProviderConfig, RssItem } from "./types.js";

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; AIModelMonitor/2.0)",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
});

/**
 * 抓取时间窗口内的 RSS 文章
 */
export async function fetchRssForProvider(
  provider: ProviderConfig,
  windowHours: number
): Promise<RssItem[]> {
  const items: RssItem[] = [];
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  for (const rssUrl of provider.rss) {
    try {
      const feed = await rssParser.parseURL(rssUrl);
      for (const entry of feed.items ?? []) {
        const url = entry.link ?? entry.guid ?? "";
        if (!url || !url.startsWith("http")) continue;

        const title = (entry.title ?? "").trim();
        if (!title) continue;

        // 过滤：只保留与模型/API相关的文章
        if (!isModelRelated(title, entry.contentSnippet ?? "")) continue;

        let publishedAt: string | undefined;
        if (entry.pubDate || entry.isoDate) {
          const d = new Date(entry.pubDate ?? entry.isoDate ?? "");
          if (!isNaN(d.getTime())) {
            // 时间窗口过滤
            if (d < windowStart) continue;
            publishedAt = d.toISOString();
          }
        }

        const summary = stripHtml(
          entry.contentSnippet || entry.content || entry.summary || ""
        ).slice(0, 500);

        items.push({
          title,
          url: url.trim(),
          published_at: publishedAt,
          summary,
          source: `${provider.name} Blog`,
        });
      }

      console.log(`[RSS] ${provider.name} (${rssUrl}): fetched ${items.length} relevant items`);
    } catch (err: any) {
      console.warn(`[RSS] Failed to fetch ${provider.name} (${rssUrl}): ${err.message}`);
    }
  }

  return items;
}

/**
 * 判断文章是否与模型/API变更相关
 * 使用关键词匹配进行初步过滤
 */
function isModelRelated(title: string, content: string): boolean {
  const text = `${title} ${content}`.toLowerCase();
  const keywords = [
    "model", "api", "gpt", "claude", "gemini", "o1", "o3", "o4",
    "sonnet", "opus", "haiku", "flash", "pro", "nano",
    "release", "launch", "announce", "update", "deprecat",
    "pricing", "rate limit", "context window", "token",
    "endpoint", "sdk", "version", "changelog",
    "模型", "发布", "更新", "接口", "版本",
  ];
  return keywords.some((kw) => text.includes(kw));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

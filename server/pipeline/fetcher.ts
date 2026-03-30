/**
 * RSS 抓取与去重模块
 *
 * 职责：
 * 1. 解析 RSS/Atom feed，提取文章列表
 * 2. URL 精确去重（对比数据库已存在的URL）
 * 3. 标题语义相似度去重（基于 TF-IDF 余弦相似度）
 */

import Parser from "rss-parser";
import { TfIdf } from "natural";
import { eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { articles as articlesTable } from "../../drizzle/schema";
import type { NotionSource } from "./notion";

export interface RawArticle {
  url: string;
  title: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt?: Date;
  rawSummary?: string;
}

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; InfoFilterBot/1.0)",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["description", "description"],
    ],
  },
});

/**
 * 从单个 RSS 源抓取文章
 */
async function fetchFeed(source: NotionSource): Promise<RawArticle[]> {
  try {
    const feed = await rssParser.parseURL(source.url);
    const articles: RawArticle[] = [];

    for (const item of feed.items ?? []) {
      const url = item.link ?? item.guid ?? "";
      if (!url || !url.startsWith("http")) continue;

      const title = (item.title ?? "").trim();
      if (!title) continue;

      // 清理 HTML 标签，提取纯文本摘要
      const rawContent =
        (item as any).contentEncoded ||
        item.content ||
        item.contentSnippet ||
        item.summary ||
        "";
      const rawSummary = stripHtml(rawContent).slice(0, 500);

      let publishedAt: Date | undefined;
      if (item.pubDate || item.isoDate) {
        const d = new Date(item.pubDate ?? item.isoDate ?? "");
        if (!isNaN(d.getTime())) publishedAt = d;
      }

      articles.push({
        url: url.trim(),
        title,
        sourceName: source.name,
        sourceUrl: source.url,
        publishedAt,
        rawSummary,
      });
    }

    console.log(`[Fetcher] ${source.name}: fetched ${articles.length} items`);
    return articles;
  } catch (err: any) {
    console.error(`[Fetcher] Failed to fetch ${source.name} (${source.url}): ${err.message}`);
    return [];
  }
}

/**
 * 从所有信息源并发抓取文章
 */
export async function fetchAllSources(sources: NotionSource[]): Promise<RawArticle[]> {
  const results = await Promise.allSettled(sources.map((s) => fetchFeed(s)));
  const all: RawArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  console.log(`[Fetcher] Total fetched: ${all.length} articles from ${sources.length} sources`);
  return all;
}

/**
 * URL 精确去重
 * 过滤掉数据库中最近 7 天内已存在的 URL
 */
export async function deduplicateByUrl(rawArticles: RawArticle[]): Promise<RawArticle[]> {
  if (rawArticles.length === 0) return [];

  const db = await getDb();
  if (!db) {
    console.warn("[Dedup] Database not available, skipping URL dedup");
    return rawArticles;
  }

  // 查询最近7天内已存在的URL
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const existingRows = await db
    .select({ url: articlesTable.url })
    .from(articlesTable)
    .where(gte(articlesTable.createdAt, sevenDaysAgo));

  const existingUrls = new Set(existingRows.map((r) => r.url));

  // 同时对本次抓取的文章做内部去重（同一批次可能有重复URL）
  const seenUrls = new Set<string>();
  const deduped: RawArticle[] = [];

  for (const article of rawArticles) {
    const normalizedUrl = normalizeUrl(article.url);
    if (!existingUrls.has(normalizedUrl) && !seenUrls.has(normalizedUrl)) {
      seenUrls.add(normalizedUrl);
      deduped.push({ ...article, url: normalizedUrl });
    }
  }

  console.log(
    `[Dedup] URL dedup: ${rawArticles.length} → ${deduped.length} (removed ${rawArticles.length - deduped.length})`
  );
  return deduped;
}

/**
 * 标题相似度去重
 * 使用 TF-IDF 余弦相似度，过滤相似度超过阈值的文章
 * 对于同一事件的多篇报道，只保留质量最高（标题最完整）的一篇
 */
export function deduplicateBySimilarity(
  articles: RawArticle[],
  threshold = 0.65
): RawArticle[] {
  if (articles.length <= 1) return articles;

  const tfidf = new TfIdf();

  // 对标题进行分词，中文按字符分割，英文按单词分割
  const tokenize = (text: string): string => {
    const lower = text.toLowerCase();
    // 将中文字符分割为单字，英文保持单词
    return lower.replace(/[\u4e00-\u9fa5]/g, (c) => ` ${c} `).trim();
  };

  const tokenizedTitles = articles.map((a) => tokenize(a.title));
  tokenizedTitles.forEach((t) => tfidf.addDocument(t));

  const kept: boolean[] = new Array(articles.length).fill(true);

  for (let i = 0; i < articles.length; i++) {
    if (!kept[i]) continue;

    for (let j = i + 1; j < articles.length; j++) {
      if (!kept[j]) continue;

      const similarity = cosineSimilarity(tfidf, i, j, tokenizedTitles);
      if (similarity >= threshold) {
        // 保留标题更长（信息量更多）的文章
        if (articles[i].title.length >= articles[j].title.length) {
          kept[j] = false;
        } else {
          kept[i] = false;
          break; // i已被淘汰，跳出内层循环
        }
      }
    }
  }

  const result = articles.filter((_, idx) => kept[idx]);
  console.log(
    `[Dedup] Similarity dedup: ${articles.length} → ${result.length} (removed ${articles.length - result.length})`
  );
  return result;
}

/**
 * 计算两篇文章标题的 TF-IDF 余弦相似度
 */
function cosineSimilarity(
  tfidf: TfIdf,
  docA: number,
  docB: number,
  tokenizedTitles: string[]
): number {
  const termsA = new Map<string, number>();
  const termsB = new Map<string, number>();

  tfidf.listTerms(docA).forEach((item) => termsA.set(item.term, item.tfidf));
  tfidf.listTerms(docB).forEach((item) => termsB.set(item.term, item.tfidf));

  // 合并所有词汇
  const allTerms = Array.from(new Set([...Array.from(termsA.keys()), ...Array.from(termsB.keys())]));

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const term of allTerms) {
    const a = termsA.get(term) ?? 0;
    const b = termsB.get(term) ?? 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 规范化 URL：移除 UTM 参数、末尾斜杠等
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // 移除常见追踪参数
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "ref", "source", "from", "via",
    ];
    trackingParams.forEach((p) => u.searchParams.delete(p));
    // 移除末尾斜杠
    let result = u.toString();
    if (result.endsWith("/") && u.pathname !== "/") {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return url;
  }
}

/**
 * 简单的 HTML 标签清理
 */
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

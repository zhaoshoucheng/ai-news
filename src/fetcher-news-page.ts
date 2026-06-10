/**
 * News Page 抓取模块
 * 
 * 从各厂商的新闻页面提取文章列表，与上次快照对比，只返回新增文章。
 * 
 * 支持的页面：
 * - Anthropic: www.anthropic.com/news (Next.js SSR with embedded JSON)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { getSnapshotsDir } from "./config.js";
import type { ProviderConfig, RssItem } from "./types.js";

/** 一条新闻文章 */
interface NewsArticle {
  title: string;
  slug: string;
  url: string;
  published_at: string;
  category?: string;
  summary?: string;
  id: string; // slug 作为唯一 ID
}

/**
 * 抓取 news 页面并检测新文章
 */
export async function fetchNewsForProvider(
  provider: ProviderConfig
): Promise<RssItem[]> {
  if (!provider.news_pages || provider.news_pages.length === 0) {
    return [];
  }

  const items: RssItem[] = [];

  for (const page of provider.news_pages) {
    try {
      const html = fetchPage(page.url, provider.name);
      if (!html) continue;

      let articles: NewsArticle[] = [];
      switch (provider.id) {
        case "anthropic":
          articles = parseAnthropicNews(html);
          break;
        default:
          console.log(`[News] ${provider.name}: no parser for ${page.url}`);
          continue;
      }

      if (articles.length === 0) {
        console.log(`[News] ${provider.name} (${page.url}): no articles parsed`);
        continue;
      }

      // 加载上次的文章 slug 列表
      const snapshotKey = `news-slugs-${provider.id}`;
      const previousSlugs = loadSlugs(snapshotKey);

      // 找出新增文章
      const newArticles = previousSlugs.size > 0
        ? articles.filter((a) => !previousSlugs.has(a.id))
        : []; // 首次运行不报告

      // 保存当前所有 slug
      const currentSlugs = new Set(articles.map((a) => a.id));
      saveSlugs(snapshotKey, currentSlugs);

      // 将新文章转换为 RssItem（带完整链接）
      for (const article of newArticles) {
        const categoryStr = article.category ? `[${article.category}] ` : "";

        items.push({
          title: `${categoryStr}${article.title}`,
          url: article.url,
          published_at: article.published_at,
          summary: article.summary || "",
          source: `${provider.name} News`,
        });
      }

      const totalParsed = articles.length;
      const newCount = newArticles.length;
      console.log(`[News] ${provider.name} (${page.url}): parsed ${totalParsed} articles, ${newCount} new`);
    } catch (err: any) {
      console.warn(`[News] Failed to fetch ${provider.name} (${page.url}): ${err.message}`);
    }
  }

  return items;
}

// ── Anthropic News 解析 ──────────────────────────────────────────────
// 页面是 Next.js SSR，HTML 中嵌入了 escaped JSON 数据

function parseAnthropicNews(html: string): NewsArticle[] {
  const articles: NewsArticle[] = [];
  const seen = new Set<string>();

  // 从 HTML 中提取 escaped JSON 格式的文章数据
  // 格式: \"publishedOn\":\"2026-06-09T17:00:00.000Z\"...\"current\":\"slug\"...\"title\":\"Title\"
  const pattern = /\\?"publishedOn\\?":\\?"([^\\]+)\\?".*?\\?"current\\?":\\?"([^\\]+)\\?".*?\\?"title\\?":\\?"([^\\]*?)\\?"/g;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    const [, dateStr, slug, rawTitle] = match;

    // 去重（页面中同一篇文章可能出现多次）
    if (seen.has(slug)) continue;
    seen.add(slug);

    // 清理标题中的转义字符
    const title = rawTitle
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ")
      .replace(/\\\\/g, "\\")
      .trim();

    // 解析日期
    const publishedAt = dateStr.split("T")[0]; // YYYY-MM-DD

    // 尝试提取分类（在 publishedOn 之前通常有 subjects）
    const category = extractCategory(html, slug);

    // 构建完整 URL
    const url = `https://www.anthropic.com/news/${slug}`;

    articles.push({
      title,
      slug,
      url,
      published_at: publishedAt + "T00:00:00Z",
      category,
      id: slug,
    });
  }

  // 按日期排序（最新在前）
  articles.sort((a, b) => b.published_at.localeCompare(a.published_at));

  return articles;
}

function extractCategory(html: string, slug: string): string | undefined {
  // 尝试在 slug 附近找到 subjects/label
  const slugIdx = html.indexOf(`"current":"${slug}"`);
  if (slugIdx === -1) {
    const escapedIdx = html.indexOf(`\\"current\\":\\"${slug}\\"`);
    if (escapedIdx === -1) return undefined;
    // Look backwards for subjects
    const chunk = html.slice(Math.max(0, escapedIdx - 500), escapedIdx);
    const labelMatch = chunk.match(/\\?"label\\?":\\?"([^\\]+)\\?"/g);
    if (labelMatch && labelMatch.length > 0) {
      const last = labelMatch[labelMatch.length - 1];
      const val = last.match(/:\\?"([^\\]+)\\?"/);
      return val ? val[1] : undefined;
    }
    return undefined;
  }

  const chunk = html.slice(Math.max(0, slugIdx - 500), slugIdx);
  const labelMatch = chunk.match(/"label":"([^"]+)"/g);
  if (labelMatch && labelMatch.length > 0) {
    const last = labelMatch[labelMatch.length - 1];
    const val = last.match(/"label":"([^"]+)"/);
    return val ? val[1] : undefined;
  }
  return undefined;
}

// ── 网络请求 ──────────────────────────────────────────────────────────

function fetchPage(url: string, providerName: string): string | null {
  try {
    // 使用 --compressed --http2 加速传输
    const html = execSync(
      `curl -s --max-time 45 --connect-timeout 15 --compressed --http2 ` +
      `-H "User-Agent: Mozilla/5.0 (compatible; AINewsBot/1.0)" ` +
      `-H "Accept: text/html,application/xhtml+xml,*/*" ` +
      `-H "Accept-Encoding: gzip, deflate, br" ` +
      `"${url}"`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 50000 }
    );

    if (html && html.length > 1000) {
      return html;
    }

    console.warn(`[News] ${providerName} (${url}): response too short (${html?.length || 0} bytes)`);
    return null;
  } catch (err: any) {
    console.warn(`[News] ${providerName} (${url}): fetch failed: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// ── 快照存储 ──────────────────────────────────────────────────────────

function loadSlugs(key: string): Set<string> {
  const path = resolve(getSnapshotsDir(), `${key}.json`);
  if (!existsSync(path)) return new Set();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as { slugs: string[]; updated_at: string };
    return new Set(data.slugs);
  } catch {
    return new Set();
  }
}

function saveSlugs(key: string, slugs: Set<string>): void {
  const path = resolve(getSnapshotsDir(), `${key}.json`);
  const data = {
    slugs: [...slugs],
    updated_at: new Date().toISOString(),
    count: slugs.size,
  };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

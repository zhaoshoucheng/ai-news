/**
 * Notion 集成模块
 *
 * 使用 @notionhq/client v5，通过 dataSources.query 查询数据库
 *
 * 职责：
 * 1. 从 Notion 信息源数据库读取 RSS 订阅列表
 * 2. 将精选文章写入 Notion 文章数据库
 * 3. 从 Notion 读取用户反馈（喜欢/不喜欢/标签）
 */

import { Client } from "@notionhq/client";

export interface NotionSource {
  name: string;
  url: string;
  category?: string;
  enabled: boolean;
}

export interface NotionArticlePayload {
  title: string;
  url: string;
  sourceName: string;
  summary: string;
  category: string;
  qualityScore: number;
  publishedAt?: Date;
}

export interface NotionFeedback {
  notionPageId: string;
  status: "liked" | "disliked" | "to_read";
  tags: string[];
  sourceName?: string;
  category?: string;
}

function getNotionClient(): Client {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN environment variable is not set");
  return new Client({ auth: token });
}

/**
 * 从 Notion 信息源数据库读取所有启用的 RSS 订阅源
 *
 * Notion 数据库需包含以下属性：
 * - Name (title): 信息源名称
 * - URL (url): RSS 地址
 * - Category (select): 分类（可选）
 * - Enabled (checkbox): 是否启用
 */
export async function fetchSourcesFromNotion(): Promise<NotionSource[]> {
  const notion = getNotionClient();
  const databaseId = process.env.NOTION_SOURCES_DB_ID;
  if (!databaseId) throw new Error("NOTION_SOURCES_DB_ID environment variable is not set");

  const sources: NotionSource[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.dataSources.query({
      data_source_id: databaseId,
      start_cursor: cursor,
      filter: {
        property: "Enabled",
        checkbox: { equals: true },
      } as any,
    });

    for (const page of response.results) {
      if (page.object !== "page") continue;
      const props = (page as any).properties;

      const name =
        props["Name"]?.title?.[0]?.plain_text ||
        props["名称"]?.title?.[0]?.plain_text ||
        "";
      const url =
        props["URL"]?.url ||
        props["Url"]?.url ||
        props["url"]?.url ||
        "";
      const category =
        props["Category"]?.select?.name ||
        props["分类"]?.select?.name ||
        undefined;

      if (name && url) {
        sources.push({ name, url, category, enabled: true });
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return sources;
}

/**
 * 将精选文章批量写入 Notion 文章数据库
 *
 * Notion 数据库需包含以下属性：
 * - Title (title): 文章标题
 * - URL (url): 文章链接
 * - Source (select): 信息源名称
 * - Summary (rich_text): AI摘要
 * - Category (select): 分类
 * - Quality Score (number): 质量分
 * - Status (select): 阅读状态，默认"📥 待阅读"
 * - Tags (multi_select): 用户标签（初始为空，用户手动添加）
 * - Published At (date): 发布时间
 */
export async function writeArticlesToNotion(
  articles: NotionArticlePayload[]
): Promise<Map<string, string>> {
  const notion = getNotionClient();
  const databaseId = process.env.NOTION_ARTICLES_DB_ID;
  if (!databaseId) throw new Error("NOTION_ARTICLES_DB_ID environment variable is not set");

  // url -> notionPageId
  const urlToPageId = new Map<string, string>();

  for (const article of articles) {
    try {
      const properties: Record<string, any> = {
        Title: {
          title: [{ text: { content: article.title.slice(0, 2000) } }],
        },
        URL: { url: article.url },
        Source: { select: { name: article.sourceName.slice(0, 100) } },
        Summary: {
          rich_text: [{ text: { content: article.summary.slice(0, 2000) } }],
        },
        Category: { select: { name: article.category.slice(0, 100) } },
        "Quality Score": { number: Math.round(article.qualityScore * 10) / 10 },
        Status: { select: { name: "📥 待阅读" } },
      };

      if (article.publishedAt) {
        properties["Published At"] = {
          date: { start: article.publishedAt.toISOString() },
        };
      }

      const page = await notion.pages.create({
        parent: { database_id: databaseId },
        properties,
      });

      urlToPageId.set(article.url, page.id);
    } catch (err: any) {
      if (err?.code === "validation_error" || err?.status === 409) {
        console.warn(`[Notion] Skipped duplicate article: ${article.title}`);
      } else {
        console.error(`[Notion] Failed to write article: ${article.title}`, err?.message);
      }
    }
  }

  return urlToPageId;
}

/**
 * 从 Notion 文章数据库读取用户的反馈标记
 * 只读取 Status 为"👍 喜欢"或"👎 不喜欢"的条目
 */
export async function fetchFeedbackFromNotion(): Promise<NotionFeedback[]> {
  const notion = getNotionClient();
  const databaseId = process.env.NOTION_ARTICLES_DB_ID;
  if (!databaseId) throw new Error("NOTION_ARTICLES_DB_ID environment variable is not set");

  const feedbacks: NotionFeedback[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.dataSources.query({
      data_source_id: databaseId,
      start_cursor: cursor,
      filter: {
        or: [
          { property: "Status", select: { equals: "👍 喜欢" } },
          { property: "Status", select: { equals: "👎 不喜欢" } },
        ],
      } as any,
    });

    for (const page of response.results) {
      if (page.object !== "page") continue;
      const props = (page as any).properties;

      const statusName = props["Status"]?.select?.name ?? "";
      let status: NotionFeedback["status"] = "to_read";
      if (statusName === "👍 喜欢") status = "liked";
      else if (statusName === "👎 不喜欢") status = "disliked";

      const tags: string[] =
        props["Tags"]?.multi_select?.map((t: any) => t.name as string) ?? [];

      const sourceName = props["Source"]?.select?.name as string | undefined;
      const category = props["Category"]?.select?.name as string | undefined;

      feedbacks.push({
        notionPageId: page.id,
        status,
        tags,
        sourceName,
        category,
      });
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return feedbacks;
}

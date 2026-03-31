/**
 * Notion 集成模块
 *
 * 直接使用 Notion REST API（fetch），绕过 @notionhq/client SDK 的版本兼容问题。
 *
 * 职责：
 * 1. 从 Notion 信息源数据库读取 RSS 订阅列表
 * 2. 将精选文章写入 Notion 文章数据库
 * 3. 从 Notion 读取用户反馈（喜欢/不喜欢/标签）
 */

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

// ── 工具函数 ──────────────────────────────────────────────────────

/** 将无连字符的 32 位 ID 格式化为标准 UUID */
function formatNotionId(raw: string): string {
  const id = raw.replace(/-/g, "");
  if (id.length !== 32) return raw; // 已经是正确格式或非标准 ID
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function getHeaders(): Record<string, string> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN environment variable is not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

async function notionRequest(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>
): Promise<any> {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Notion API error ${resp.status} on ${method} ${path}: ${data?.message ?? JSON.stringify(data)}`
    );
  }
  return data;
}

// ── 查询数据库（分页） ─────────────────────────────────────────────

async function queryDatabase(
  databaseId: string,
  filter?: Record<string, unknown>
): Promise<any[]> {
  const id = formatNotionId(databaseId);
  const results: any[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;

    const data = await notionRequest("POST", `/databases/${id}/query`, body);
    results.push(...(data.results ?? []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

// ── 公开 API ──────────────────────────────────────────────────────

/**
 * 从 Notion 信息源数据库读取所有启用的 RSS 订阅源
 */
export async function fetchSourcesFromNotion(): Promise<NotionSource[]> {
  const databaseId = process.env.NOTION_SOURCES_DB_ID;
  if (!databaseId) throw new Error("NOTION_SOURCES_DB_ID environment variable is not set");

  const pages = await queryDatabase(databaseId, {
    property: "Enabled",
    checkbox: { equals: true },
  });

  const sources: NotionSource[] = [];
  for (const page of pages) {
    const props = page.properties ?? {};
    const name =
      props["名称"]?.title?.[0]?.plain_text ||
      props["Name"]?.title?.[0]?.plain_text ||
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

  return sources;
}

/**
 * 将精选文章批量写入 Notion 文章数据库
 */
export async function writeArticlesToNotion(
  articles: NotionArticlePayload[]
): Promise<Map<string, string>> {
  const databaseId = process.env.NOTION_ARTICLES_DB_ID;
  if (!databaseId) throw new Error("NOTION_ARTICLES_DB_ID environment variable is not set");

  const dbId = formatNotionId(databaseId);
  const urlToPageId = new Map<string, string>();

  for (const article of articles) {
    try {
      const properties: Record<string, unknown> = {
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

      const page = await notionRequest("POST", "/pages", {
        parent: { database_id: dbId },
        properties,
      });

      urlToPageId.set(article.url, page.id);
    } catch (err: any) {
      // 重复文章或字段验证错误，跳过不中断
      console.warn(`[Notion] Skipped article "${article.title.slice(0, 50)}": ${err.message?.slice(0, 100)}`);
    }
  }

  return urlToPageId;
}

/**
 * 从 Notion 文章数据库读取用户的反馈标记
 */
export async function fetchFeedbackFromNotion(): Promise<NotionFeedback[]> {
  const databaseId = process.env.NOTION_ARTICLES_DB_ID;
  if (!databaseId) throw new Error("NOTION_ARTICLES_DB_ID environment variable is not set");

  const pages = await queryDatabase(databaseId, {
    or: [
      { property: "Status", select: { equals: "👍 喜欢" } },
      { property: "Status", select: { equals: "👎 不喜欢" } },
    ],
  });

  const feedbacks: NotionFeedback[] = [];
  for (const page of pages) {
    const props = page.properties ?? {};
    const statusName = props["Status"]?.select?.name ?? "";
    let status: NotionFeedback["status"] = "to_read";
    if (statusName === "👍 喜欢") status = "liked";
    else if (statusName === "👎 不喜欢") status = "disliked";

    const tags: string[] =
      props["Tags"]?.multi_select?.map((t: any) => t.name as string) ?? [];
    const sourceName = props["Source"]?.select?.name as string | undefined;
    const category = props["Category"]?.select?.name as string | undefined;

    feedbacks.push({ notionPageId: page.id, status, tags, sourceName, category });
  }

  return feedbacks;
}

/**
 * Changelog 结构化解析模块
 * 
 * 从各厂商的 changelog/release-notes 页面提取结构化条目，
 * 与上次快照对比，只返回新增的变更条目。
 * 
 * 支持的页面：
 * - OpenAI: developers.openai.com/api/docs/changelog
 * - Anthropic: platform.claude.com/docs/en/release-notes/overview
 * - Gemini: ai.google.dev/gemini-api/docs/changelog
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { getSnapshotsDir } from "./config.js";
import type { ProviderConfig, RssItem } from "./types.js";

/** 一条结构化的 changelog 条目 */
interface ChangelogEntry {
  date: string;       // ISO 格式日期 (YYYY-MM-DD)
  type?: string;      // Feature / Update / Fix / Deprecation
  tags: string[];     // 相关模型或 endpoint 标签
  content: string;    // 条目内容摘要
  id: string;         // 用于去重的唯一标识
}

/**
 * 抓取 changelog 页面并检测新条目
 */
export async function fetchChangelogForProvider(
  provider: ProviderConfig
): Promise<RssItem[]> {
  const items: RssItem[] = [];

  for (const url of provider.changelog_urls) {
    try {
      const html = await fetchWithRetry(url, provider.name);
      if (!html) continue;

      // 根据 provider 选择解析策略
      let entries: ChangelogEntry[] = [];
      switch (provider.id) {
        case "openai":
          entries = parseOpenAIChangelog(html);
          break;
        case "anthropic":
          entries = parseAnthropicChangelog(html);
          break;
        case "gemini":
          entries = parseGeminiChangelog(html);
          break;
        default:
          entries = [];
      }

      if (entries.length === 0) {
        console.log(`[Changelog] ${provider.name} (${url}): no entries parsed`);
        continue;
      }

      // 加载上次的条目 ID 列表
      const snapshotKey = `changelog-ids-${provider.id}-${hashUrl(url)}`;
      const previousIds = loadEntryIds(snapshotKey);

      // 找出新增条目
      const newEntries = previousIds.size > 0
        ? entries.filter((e) => !previousIds.has(e.id))
        : []; // 首次运行不报告（避免刷屏）

      // 保存当前所有条目 ID
      const currentIds = new Set(entries.map((e) => e.id));
      saveEntryIds(snapshotKey, currentIds);

      // 将新条目转换为 RssItem
      for (const entry of newEntries) {
        const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
        const typeStr = entry.type ? `[${entry.type}] ` : "";

        items.push({
          title: `${typeStr}${provider.name} Changelog ${entry.date}${tagsStr}`,
          url,
          published_at: entry.date + "T00:00:00Z",
          summary: entry.content.slice(0, 500),
          source: `${provider.name} Changelog`,
        });
      }

      const totalParsed = entries.length;
      const newCount = newEntries.length;
      console.log(`[Changelog] ${provider.name} (${url}): parsed ${totalParsed} entries, ${newCount} new`);
    } catch (err: any) {
      console.warn(`[Changelog] Failed to fetch ${provider.name} (${url}): ${err.message}`);
    }
  }

  return items;
}

// ── OpenAI Changelog 解析 ─────────────────────────────────────────────
// 结构: <h3>June, 2026</h3> → <Badge>Jun 9</Badge> → <Badge>Feature</Badge> → <Badge>tags</Badge> → <p>content</p>

function parseOpenAIChangelog(html: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const text = htmlToText(html);

  // OpenAI 的月份标题格式: "June, 2026" 或 "May, 2026"
  const monthPattern = /(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})/gi;
  const monthMatches = [...text.matchAll(monthPattern)];

  for (let mi = 0; mi < monthMatches.length; mi++) {
    const monthName = monthMatches[mi][1];
    const year = monthMatches[mi][2];
    const blockStart = monthMatches[mi].index! + monthMatches[mi][0].length;
    const blockEnd = mi + 1 < monthMatches.length ? monthMatches[mi + 1].index! : text.length;
    const block = text.slice(blockStart, blockEnd);

    // 短月份名缩写
    const shortMonth = monthName.slice(0, 3);

    // 按日期分割: "Jun 9", "Jun 5" 等
    const dayPattern = new RegExp(`(${shortMonth}\\s+\\d{1,2})`, "gi");
    const dayMatches = [...block.matchAll(dayPattern)];

    for (let di = 0; di < dayMatches.length; di++) {
      const dayStr = dayMatches[di][1]; // e.g., "Jun 9"
      const entryStart = dayMatches[di].index! + dayMatches[di][0].length;
      const entryEnd = di + 1 < dayMatches.length ? dayMatches[di + 1].index! : block.length;
      const entryContent = block.slice(entryStart, entryEnd).trim();

      if (!entryContent || entryContent.length < 20) continue;

      const date = parseDate(`${dayStr}, ${year}`);
      if (!date) continue;

      const type = extractTypeFromContent(entryContent);
      const tags = extractAllTags(entryContent);
      const content = entryContent.slice(0, 600).trim();
      const id = generateId(date, content);

      entries.push({ date, type, tags, content, id });
    }
  }

  return entries;
}

// ── Anthropic Changelog 解析 ──────────────────────────────────────────
// 结构: "June 9, 2026" 后跟列表项

function parseAnthropicChangelog(html: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const text = htmlToText(html);

  // 日期模式: "June 9, 2026"
  const datePattern = /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi;
  const dateMatches = [...text.matchAll(datePattern)];

  // 过滤掉正文中提到的未来日期（如 "retirement on August 5, 2026"）
  // 只保留作为段落开头的日期
  const sectionDates: Array<{ date: string; index: number }> = [];
  for (const m of dateMatches) {
    const idx = m.index!;
    // 检查日期前面是否是换行或段落开头（前20字符内没有字母）
    const before = text.slice(Math.max(0, idx - 30), idx);
    if (/\n\s*$/.test(before) || idx < 50) {
      const parsed = parseDate(m[1]);
      if (parsed) {
        sectionDates.push({ date: parsed, index: idx + m[0].length });
      }
    }
  }

  for (let i = 0; i < sectionDates.length; i++) {
    const { date, index: startIdx } = sectionDates[i];
    const endIdx = i + 1 < sectionDates.length ? sectionDates[i + 1].index - 30 : text.length;
    const block = text.slice(startIdx, endIdx).trim();

    if (block.length < 30) continue;

    // 整个日期块作为一个条目（Anthropic 通常一个日期下有多条更新）
    const tags = extractAllTags(block);
    const type = inferType(block);
    const content = block.slice(0, 800).trim();
    const id = generateId(date, content);

    entries.push({ date, type, tags, content, id });
  }

  return entries;
}

// ── Gemini Changelog 解析 ─────────────────────────────────────────────
// 结构: "June 1, 2026" 后跟列表项

function parseGeminiChangelog(html: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const text = htmlToText(html);

  // 日期模式: "June 1, 2026"
  const datePattern = /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi;
  const dateMatches = [...text.matchAll(datePattern)];

  // 只保留作为段落标题的日期
  const sectionDates: Array<{ date: string; index: number }> = [];
  for (const m of dateMatches) {
    const idx = m.index!;
    const before = text.slice(Math.max(0, idx - 30), idx);
    if (/\n\s*$/.test(before) || idx < 100) {
      const parsed = parseDate(m[1]);
      if (parsed) {
        sectionDates.push({ date: parsed, index: idx + m[0].length });
      }
    }
  }

  for (let i = 0; i < sectionDates.length; i++) {
    const { date, index: startIdx } = sectionDates[i];
    const endIdx = i + 1 < sectionDates.length ? sectionDates[i + 1].index - 30 : text.length;
    const block = text.slice(startIdx, endIdx).trim();

    if (block.length < 20) continue;

    const tags = extractAllTags(block);
    const type = inferType(block);
    const content = block.slice(0, 800).trim();
    const id = generateId(date, content);

    entries.push({ date, type, tags, content, id });
  }

  return entries;
}

// ── 网络请求 ──────────────────────────────────────────────────────────

/**
 * 带重试和 fallback 的页面抓取
 * - 先尝试 Node.js fetch（适用于大多数页面）
 * - 如果遇到重定向循环（如 Google OAuth），自动 fallback 到 curl
 * - 超时 45 秒，最多重试 2 次
 */
async function fetchWithRetry(
  url: string,
  providerName: string,
  maxRetries = 2
): Promise<string | null> {
  // 已知需要 curl 的域名（Google 的 OAuth 重定向循环问题）
  const curlDomains = ["ai.google.dev", "developers.google.com"];
  const needsCurl = curlDomains.some((d) => url.includes(d));

  if (needsCurl) {
    return fetchWithCurl(url, providerName, maxRetries);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*",
        },
        signal: AbortSignal.timeout(45000),
      });

      if (!resp.ok) {
        console.warn(`[Changelog] ${providerName} (${url}): HTTP ${resp.status}`);
        return null;
      }

      return await resp.text();
    } catch (err: any) {
      const isRetryable =
        err.name === "TimeoutError" ||
        err.message?.includes("timeout") ||
        err.message?.includes("aborted") ||
        err.message?.includes("redirect") ||
        err.message?.includes("fetch failed");

      if (isRetryable && attempt < maxRetries) {
        const waitMs = (attempt + 1) * 5000;
        console.warn(
          `[Changelog] ${providerName} (${url}): ${err.message}, retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // 最后尝试 curl fallback
      console.warn(`[Changelog] ${providerName} (${url}): fetch failed, trying curl fallback...`);
      return fetchWithCurl(url, providerName, 1);
    }
  }
  return null;
}

/**
 * 使用 curl 抓取页面（解决 Google OAuth 重定向循环问题）
 * curl 不发送 cookie，Google 对无 cookie 的请求直接返回 SSR 内容
 */
function fetchWithCurl(
  url: string,
  providerName: string,
  maxRetries = 2
): string | null {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 使用简单 bot UA 避免 Google OAuth 重定向循环
      // Chrome UA 会触发 Google 的登录流程，bot UA 直接返回 SSR 内容
      const html = execSync(
        `curl -s --max-time 45 --connect-timeout 10 ` +
        `-H "User-Agent: Mozilla/5.0 (compatible; AINewsBot/1.0)" ` +
        `-H "Accept: text/html,application/xhtml+xml,*/*" ` +
        `"${url}"`,
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 50000 }
      );

      if (html && html.length > 1000) {
        return html;
      }

      console.warn(`[Changelog] ${providerName} (${url}): curl returned empty/short response`);
    } catch (err: any) {
      if (attempt < maxRetries) {
        console.warn(
          `[Changelog] ${providerName} (${url}): curl attempt ${attempt + 1} failed, retrying...`
        );
        continue;
      }
      console.warn(`[Changelog] ${providerName} (${url}): curl failed: ${err.message?.slice(0, 100)}`);
    }
  }
  return null;
}

// ── 工具函数 ──────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseDate(dateStr: string): string | null {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split("T")[0];
    }
  } catch {}
  return null;
}

function extractTypeFromContent(content: string): string | undefined {
  const lower = content.toLowerCase().slice(0, 100);
  if (lower.includes("feature")) return "Feature";
  if (lower.includes("update")) return "Update";
  if (lower.includes("fix")) return "Fix";
  if (lower.includes("deprecat")) return "Deprecation";
  return undefined;
}

function inferType(content: string): string | undefined {
  const lower = content.toLowerCase();
  if (lower.includes("released") || lower.includes("launched") || lower.includes("now available") || lower.includes("added")) return "Feature";
  if (lower.includes("deprecat") || lower.includes("shut down") || lower.includes("removed") || lower.includes("will be shut down")) return "Deprecation";
  if (lower.includes("updated") || lower.includes("changed") || lower.includes("renamed") || lower.includes("announced")) return "Update";
  if (lower.includes("fix") || lower.includes("bug")) return "Fix";
  return undefined;
}

function extractAllTags(content: string): string[] {
  const tags: string[] = [];
  const patterns = [
    /\b(gpt-[\w.-]+)\b/gi,
    /\b(claude-[\w.-]+)\b/gi,
    /\b(gemini-[\w.-]+)\b/gi,
    /\b(gemma-[\w.-]+)\b/gi,
    /\b(dall-e-\d)\b/gi,
    /\b(sora-[\w.-]+)\b/gi,
    /\b(v1\/[\w/]+)\b/g,
    /\b(o[134]-[\w.-]+)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const m of content.matchAll(pattern)) {
      const tag = m[1];
      if (!tags.includes(tag) && tag.length > 3) tags.push(tag);
    }
  }
  return tags.slice(0, 10);
}

function generateId(date: string, content: string): string {
  // 用日期 + 内容前 120 字符的 hash 作为 ID
  const key = `${date}:${content.slice(0, 120).replace(/\s+/g, " ")}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${date}-${Math.abs(hash).toString(36)}`;
}

function hashUrl(url: string): string {
  const parts = url.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || "index";
}

// ── 快照存储 ──────────────────────────────────────────────────────────

function loadEntryIds(key: string): Set<string> {
  const path = resolve(getSnapshotsDir(), `${key}.json`);
  if (!existsSync(path)) return new Set();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as { ids: string[]; updated_at: string };
    return new Set(data.ids);
  } catch {
    return new Set();
  }
}

function saveEntryIds(key: string, ids: Set<string>): void {
  const path = resolve(getSnapshotsDir(), `${key}.json`);
  const data = {
    ids: [...ids],
    updated_at: new Date().toISOString(),
    count: ids.size,
  };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

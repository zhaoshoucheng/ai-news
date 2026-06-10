/**
 * Changelog 页面抓取模块
 * 从各厂商的 changelog/release-notes 页面提取最新变更
 * 
 * 由于这些页面没有 RSS，我们通过抓取页面内容并与上次对比来检测变更
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getSnapshotsDir } from "./config.js";
import type { ProviderConfig, RssItem } from "./types.js";

/**
 * 抓取 changelog 页面并检测新内容
 */
export async function fetchChangelogForProvider(
  provider: ProviderConfig
): Promise<RssItem[]> {
  const items: RssItem[] = [];

  for (const url of provider.changelog_urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AIModelMonitor/2.0)",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.warn(`[Changelog] ${provider.name} (${url}): HTTP ${resp.status}`);
        continue;
      }

      const html = await resp.text();
      const content = extractTextContent(html);

      // 对比上次快照
      const snapshotKey = `changelog-${provider.id}-${hashUrl(url)}`;
      const previousContent = loadChangelogSnapshot(snapshotKey);

      if (previousContent && content !== previousContent) {
        // 检测到变更，提取新增部分
        const newContent = findNewContent(previousContent, content);
        if (newContent) {
          items.push({
            title: `[${provider.name}] Changelog 更新`,
            url,
            published_at: new Date().toISOString(),
            summary: newContent.slice(0, 500),
            source: `${provider.name} Changelog`,
          });
        }
      }

      // 保存当前快照
      saveChangelogSnapshot(snapshotKey, content);
    } catch (err: any) {
      console.warn(`[Changelog] Failed to fetch ${provider.name} (${url}): ${err.message}`);
    }
  }

  if (items.length > 0) {
    console.log(`[Changelog] ${provider.name}: detected ${items.length} changelog updates`);
  }

  return items;
}

/**
 * 从 HTML 中提取纯文本内容（简单实现）
 */
function extractTextContent(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000); // 限制长度避免过大
}

/**
 * 找出新增的内容（简单 diff）
 */
function findNewContent(oldContent: string, newContent: string): string | null {
  // 简单策略：如果新内容比旧内容长，提取开头差异部分
  if (newContent.length <= oldContent.length) {
    // 内容可能被重组，检查是否有实质变化
    if (newContent.slice(0, 200) === oldContent.slice(0, 200)) {
      return null;
    }
    return newContent.slice(0, 300);
  }

  // 找到第一个不同的位置
  let diffStart = 0;
  const minLen = Math.min(oldContent.length, newContent.length, 500);
  for (let i = 0; i < minLen; i++) {
    if (oldContent[i] !== newContent[i]) {
      diffStart = Math.max(0, i - 20);
      break;
    }
  }

  return newContent.slice(diffStart, diffStart + 500);
}

function loadChangelogSnapshot(key: string): string | null {
  const path = resolve(getSnapshotsDir(), `${key}.txt`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function saveChangelogSnapshot(key: string, content: string): void {
  const path = resolve(getSnapshotsDir(), `${key}.txt`);
  writeFileSync(path, content, "utf-8");
}

function hashUrl(url: string): string {
  // 简单 hash：取 URL 最后一段路径
  const parts = url.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || "index";
}

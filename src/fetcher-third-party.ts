/**
 * 第三方数据源抓取模块
 * 
 * 目前支持：
 * - Artificial Analysis (artificialanalysis.ai/changelog)
 *   独立 AI 模型基准测试平台，提供 Intelligence Index、速度、成本对比
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getSnapshotsDir } from "./config.js";
import type { ThirdPartySource, RssItem } from "./types.js";

/** Artificial Analysis changelog 条目 */
interface AAEntry {
  date: string;       // YYYY-MM-DD
  type: string;       // "evaluation" | "article" | "feature" | "provider" | "model"
  title: string;      // 条目标题
  detail: string;     // 详细内容
  models: string[];   // 相关模型名
  id: string;         // 唯一标识
}

/**
 * 抓取第三方数据源的 changelog
 */
export async function fetchThirdPartyChangelog(
  source: ThirdPartySource
): Promise<RssItem[]> {
  switch (source.id) {
    case "artificial_analysis":
      return fetchArtificialAnalysis(source);
    default:
      console.warn(`[ThirdParty] Unknown source: ${source.id}`);
      return [];
  }
}

/**
 * 抓取 Artificial Analysis changelog
 */
async function fetchArtificialAnalysis(source: ThirdPartySource): Promise<RssItem[]> {
  try {
    const resp = await fetch(source.changelog_url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      console.warn(`[ThirdParty] ${source.name}: HTTP ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    const entries = parseAAChangelog(html);

    if (entries.length === 0) {
      console.log(`[ThirdParty] ${source.name}: no entries parsed`);
      return [];
    }

    // 过滤：只保留与关注的厂商相关的条目
    const relevantEntries = filterRelevantEntries(entries, source.filter_keywords);

    // 加载上次的条目 ID 列表
    const snapshotKey = `third-party-ids-${source.id}`;
    const previousIds = loadEntryIds(snapshotKey);

    // 找出新增条目
    const newEntries = previousIds.size > 0
      ? relevantEntries.filter((e) => !previousIds.has(e.id))
      : []; // 首次运行建立基线

    // 保存所有相关条目的 ID（不只是过滤后的，保存全部以避免重复检测）
    const allIds = new Set(entries.map((e) => e.id));
    saveEntryIds(snapshotKey, allIds);

    // 转换为 RssItem
    const items: RssItem[] = newEntries.map((entry) => ({
      title: `[${source.name}] ${entry.title}`,
      url: source.changelog_url,
      published_at: entry.date + "T00:00:00Z",
      summary: entry.detail.slice(0, 500),
      source: source.name,
    }));

    const totalParsed = entries.length;
    const relevantCount = relevantEntries.length;
    const newCount = newEntries.length;
    console.log(
      `[ThirdParty] ${source.name}: parsed ${totalParsed} entries, ` +
      `${relevantCount} relevant to tracked providers, ${newCount} new`
    );

    return items;
  } catch (err: any) {
    console.warn(`[ThirdParty] Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

/**
 * 解析 Artificial Analysis changelog HTML
 * 
 * 页面结构：
 * - 日期标题: "#### 08 Jun 2026" 或 HTML 中的日期分隔
 * - 条目类型: 🔔 New article / New language model evaluation / New model in Leaderboard / 🚀 New feature
 * - 条目内容: 模型名 + 评分/描述
 */
function parseAAChangelog(html: string): AAEntry[] {
  const entries: AAEntry[] = [];
  const text = htmlToText(html);

  // AA 的日期格式: "08 Jun 2026" 或 "04 Jun 2026"
  const datePattern = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/gi;
  const dateMatches = [...text.matchAll(datePattern)];

  // 去重日期（只保留作为段落标题的）
  const sectionDates: Array<{ date: string; index: number }> = [];
  const seenDates = new Set<string>();

  for (const m of dateMatches) {
    const day = m[1].padStart(2, "0");
    const monthStr = m[2];
    const year = m[3];
    const date = parseAADate(day, monthStr, year);
    if (!date) continue;

    // 检查是否是段落标题（前面是换行）
    const idx = m.index!;
    const before = text.slice(Math.max(0, idx - 20), idx);
    if (/\n\s*$/.test(before) || idx < 200) {
      const key = `${date}-${idx}`;
      if (!seenDates.has(date) || sectionDates.length === 0) {
        sectionDates.push({ date, index: idx + m[0].length });
        seenDates.add(date);
      } else if (seenDates.has(date)) {
        // 同一天可能出现多次，跳过
        continue;
      }
    }
  }

  // 按日期段落提取条目
  for (let i = 0; i < sectionDates.length; i++) {
    const { date, index: startIdx } = sectionDates[i];
    const endIdx = i + 1 < sectionDates.length ? sectionDates[i + 1].index - 20 : text.length;
    const block = text.slice(startIdx, endIdx).trim();

    if (block.length < 20) continue;

    // 分割为子条目
    const subEntries = splitAABlock(block, date);
    entries.push(...subEntries);
  }

  return entries;
}

/**
 * 将一个日期块分割为多个子条目
 */
function splitAABlock(block: string, date: string): AAEntry[] {
  const entries: AAEntry[] = [];

  // 按条目类型标记分割
  const entryPatterns = [
    /(?:🔔\s*)?New article published\s*/gi,
    /New language model evaluation(?:\s+results available)?\s*/gi,
    /New (?:model in|image model|video model)\s*/gi,
    /(?:🚀\s*)?New (?:website )?feature\s*/gi,
    /(\w+)\s+performance results now available/gi,
  ];

  // 简单方法：按换行分割，然后合并相关行
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  let currentEntry: { type: string; lines: string[] } | null = null;

  for (const line of lines) {
    const lineType = classifyAALine(line);

    if (lineType !== "content" && currentEntry) {
      // 保存上一个条目
      const entry = buildAAEntry(currentEntry, date);
      if (entry) entries.push(entry);
      currentEntry = null;
    }

    if (lineType === "article") {
      currentEntry = { type: "article", lines: [line] };
    } else if (lineType === "evaluation") {
      currentEntry = { type: "evaluation", lines: [line] };
    } else if (lineType === "model") {
      currentEntry = { type: "model", lines: [line] };
    } else if (lineType === "feature") {
      currentEntry = { type: "feature", lines: [line] };
    } else if (lineType === "provider") {
      currentEntry = { type: "provider", lines: [line] };
    } else if (currentEntry) {
      currentEntry.lines.push(line);
    }
  }

  // 处理最后一个条目
  if (currentEntry) {
    const entry = buildAAEntry(currentEntry, date);
    if (entry) entries.push(entry);
  }

  return entries;
}

function classifyAALine(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("new article published") || lower.startsWith("🔔")) return "article";
  if (lower.includes("new language model evaluation") || lower.includes("evaluation results available")) return "evaluation";
  if (lower.includes("new model in") || lower.includes("new image model") || lower.includes("new video model")) return "model";
  if (lower.includes("new feature") || lower.includes("new website feature") || lower.startsWith("🚀")) return "feature";
  if (lower.includes("performance results now available")) return "provider";
  return "content";
}

function buildAAEntry(raw: { type: string; lines: string[] }, date: string): AAEntry | null {
  const fullText = raw.lines.join(" ").trim();
  if (fullText.length < 10) return null;

  // 提取模型名
  const models = extractModelNames(fullText);

  // 提取标题（通常是第一行或加粗文本后的内容）
  let title = "";
  let detail = fullText;

  switch (raw.type) {
    case "article":
      // 文章标题通常在 "New article published" 之后
      title = fullText.replace(/.*?New article published\s*/i, "").split(/\n/)[0].trim();
      if (!title) title = raw.lines.slice(1).join(" ").slice(0, 100);
      break;
    case "evaluation":
      // 评测标题通常是模型名
      const evalModel = models[0] || raw.lines.slice(1).join(" ").slice(0, 60);
      title = `New evaluation: ${evalModel}`;
      break;
    case "model":
      title = `New model: ${models[0] || raw.lines.slice(1).join(" ").slice(0, 60)}`;
      break;
    case "feature":
      title = fullText.replace(/.*?New (?:website )?feature\s*/i, "").split(/\n/)[0].trim();
      if (!title) title = raw.lines.slice(1).join(" ").slice(0, 100);
      title = `Feature: ${title}`;
      break;
    case "provider":
      title = fullText.slice(0, 80);
      break;
    default:
      title = fullText.slice(0, 80);
  }

  title = title.slice(0, 120).trim();
  detail = detail.slice(0, 400).trim();

  const id = generateId(date, `${raw.type}:${title}`);

  return { date, type: raw.type, title, detail, models, id };
}

/**
 * 过滤只保留与关注厂商相关的条目
 */
function filterRelevantEntries(entries: AAEntry[], keywords: string[]): AAEntry[] {
  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  return entries.filter((entry) => {
    const searchText = `${entry.title} ${entry.detail} ${entry.models.join(" ")}`.toLowerCase();
    return lowerKeywords.some((kw) => searchText.includes(kw));
  });
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

function parseAADate(day: string, monthStr: string, year: string): string | null {
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const month = months[monthStr.toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

function extractModelNames(text: string): string[] {
  const models: string[] = [];
  const patterns = [
    /\b(GPT-[\w.-]+)\b/gi,
    /\b(Claude\s+[\w\s.]+?\d[\w.]*)/gi,
    /\b(claude-[\w.-]+)\b/gi,
    /\b(Gemini\s+[\w\s.]+?\d[\w.]*)/gi,
    /\b(gemini-[\w.-]+)\b/gi,
    /\b(Grok\s+[\w.]+)/gi,
    /\b(DeepSeek\s+[\w\s.]+)/gi,
    /\b(Qwen[\w.]+\s*[\w.]*)/gi,
    /\b(Llama\s+[\w.]+)/gi,
    /\b(Nemotron\s+[\w\s.]+)/gi,
  ];
  for (const p of patterns) {
    for (const m of text.matchAll(p)) {
      const name = m[1].trim();
      if (!models.includes(name) && name.length > 3) models.push(name);
    }
  }
  return models.slice(0, 10);
}

function generateId(date: string, content: string): string {
  const key = `${date}:${content.slice(0, 120).replace(/\s+/g, " ")}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${date}-${Math.abs(hash).toString(36)}`;
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

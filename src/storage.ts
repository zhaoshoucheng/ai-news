/**
 * 历史记录存储模块
 * 将每日检测结果保存为 JSON 文件，供周报汇总使用
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { getHistoryDir, getWeeklyDir } from "./config.js";
import type { DailyReport, ChangeDetectionResult } from "./types.js";

/**
 * 保存每日报告
 */
export function saveDailyReport(report: DailyReport): void {
  const historyDir = getHistoryDir();
  const filename = `${report.date}.json`;
  const filepath = resolve(historyDir, filename);
  writeFileSync(filepath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[Storage] Saved daily report: ${filename}`);
}

/**
 * 读取指定日期范围内的每日报告
 */
export function loadDailyReports(startDate: string, endDate: string): DailyReport[] {
  const historyDir = getHistoryDir();
  const reports: DailyReport[] = [];

  if (!existsSync(historyDir)) return reports;

  const files = readdirSync(historyDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const date = file.replace(".json", "");
    if (date >= startDate && date <= endDate) {
      try {
        const raw = readFileSync(resolve(historyDir, file), "utf-8");
        reports.push(JSON.parse(raw) as DailyReport);
      } catch {
        // skip corrupted files
      }
    }
  }

  return reports.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 保存周报
 */
export function saveWeeklyReport(weekStart: string, content: string): void {
  const weeklyDir = getWeeklyDir();
  const filename = `week-${weekStart}.md`;
  const filepath = resolve(weeklyDir, filename);
  writeFileSync(filepath, content, "utf-8");
  console.log(`[Storage] Saved weekly report: ${filename}`);
}

/**
 * 获取已处理的 RSS URL 列表（用于去重）
 * 从最近 7 天的历史记录中提取
 */
export function getRecentRssUrls(): Set<string> {
  const urls = new Set<string>();
  const historyDir = getHistoryDir();

  if (!existsSync(historyDir)) return urls;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const files = readdirSync(historyDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const date = file.replace(".json", "");
    if (date >= sevenDaysAgo) {
      try {
        const raw = readFileSync(resolve(historyDir, file), "utf-8");
        const report = JSON.parse(raw) as DailyReport;
        for (const change of report.changes) {
          for (const item of change.rss_updates) {
            urls.add(item.url);
          }
        }
      } catch {
        // skip
      }
    }
  }

  return urls;
}

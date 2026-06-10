/**
 * 每日检测入口
 * 
 * 执行流程：
 * 1. 加载配置
 * 2. 对每个 provider：抓取 RSS + API 模型列表
 * 3. 与历史快照对比，检测变更
 * 4. 如果有变更：生成 LLM 报告 → 发送 Slack
 * 5. 保存新快照和历史记录
 * 
 * 调度：每天早上 9:00 执行
 * 参数：--dry-run 仅检测不发送
 */

import "dotenv/config";
import { loadConfig } from "./config.js";
import { fetchRssForProvider } from "./fetcher-rss.js";
import { fetchModelsForProvider } from "./fetcher-api.js";
import { fetchChangelogForProvider } from "./fetcher-changelog.js";
import { fetchThirdPartyChangelog } from "./fetcher-third-party.js";
import { fetchNewsForProvider } from "./fetcher-news-page.js";
import { loadPreviousSnapshot, saveSnapshot, detectChanges } from "./diff.js";
import { generateDailyReport } from "./llm.js";
import { sendToSlack } from "./slack.js";
import { saveDailyReport, getRecentRssUrls } from "./storage.js";
import type { ChangeDetectionResult, DailyReport, RssItem } from "./types.js";

const isDryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const startTime = Date.now();
  const today = new Date().toISOString().split("T")[0];

  console.log("═".repeat(60));
  console.log(`[Daily] AI Model Monitor - Daily Check`);
  console.log(`[Daily] Date: ${today}`);
  console.log(`[Daily] Mode: ${isDryRun ? "DRY RUN (no Slack)" : "PRODUCTION"}`);
  console.log("═".repeat(60));

  const config = loadConfig();
  const recentUrls = getRecentRssUrls();
  const allChanges: ChangeDetectionResult[] = [];

  for (const provider of config.providers) {
    console.log(`\n── ${provider.name} ──────────────────────────────────`);

    // 1. 抓取 RSS
    console.log(`[Daily] Fetching RSS for ${provider.name}...`);
    let rssItems = await fetchRssForProvider(provider, config.settings.fetch_window_hours);

    // 2b. 抓取 Changelog 页面
    console.log(`[Daily] Fetching changelog for ${provider.name}...`);
    const changelogItems = await fetchChangelogForProvider(provider);
    rssItems = [...rssItems, ...changelogItems];

    // 2c. 抓取 News 页面
    if (provider.news_pages && provider.news_pages.length > 0) {
      console.log(`[Daily] Fetching news page for ${provider.name}...`);
      const newsItems = await fetchNewsForProvider(provider);
      rssItems = [...rssItems, ...newsItems];
    }

    // RSS 去重（排除已处理过的 URL）
    const beforeDedup = rssItems.length;
    rssItems = rssItems.filter((item) => !recentUrls.has(item.url));
    if (beforeDedup > rssItems.length) {
      console.log(`[Daily] RSS dedup: ${beforeDedup} → ${rssItems.length}`);
    }

    // 2. 抓取 API 模型列表
    console.log(`[Daily] Fetching API models for ${provider.name}...`);
    const newSnapshot = await fetchModelsForProvider(provider);

    // 3. 加载旧快照并对比
    const oldSnapshot = loadPreviousSnapshot(provider.id);
    const changes = detectChanges(
      provider.id,
      provider.name,
      oldSnapshot,
      newSnapshot,
      rssItems
    );

    allChanges.push(changes);

    // 4. 保存新快照（无论是否有变更都要更新）
    if (newSnapshot.models.length > 0) {
      saveSnapshot(newSnapshot);
    }

    // 输出变更摘要
    if (changes.has_changes) {
      console.log(`[Daily] ✅ Changes detected for ${provider.name}:`);
      if (changes.new_models.length > 0)
        console.log(`  - New models: ${changes.new_models.map((m) => m.id).join(", ")}`);
      if (changes.removed_models.length > 0)
        console.log(`  - Removed models: ${changes.removed_models.map((m) => m.id).join(", ")}`);
      if (changes.changed_models.length > 0)
        console.log(`  - Changed models: ${changes.changed_models.map((m) => m.model_id).join(", ")}`);
      if (changes.rss_updates.length > 0)
        console.log(`  - RSS updates: ${changes.rss_updates.length} articles`);
    } else {
      console.log(`[Daily] ⏭️ No changes for ${provider.name}`);
    }
  }

  // ── 第三方数据源 ──────────────────────────────────────────
  let thirdPartyItems: RssItem[] = [];
  if (config.third_party && config.third_party.length > 0) {
    for (const source of config.third_party) {
      console.log(`\n── ${source.name} (Third Party) ──────────────────────────────────`);
      console.log(`[Daily] Fetching changelog for ${source.name}...`);
      const items = await fetchThirdPartyChangelog(source);
      thirdPartyItems = [...thirdPartyItems, ...items];

      if (items.length > 0) {
        console.log(`[Daily] ✅ ${items.length} new relevant updates from ${source.name}`);
      } else {
        console.log(`[Daily] ⏭️ No new relevant updates from ${source.name}`);
      }
    }
  }

  // 将第三方条目添加到一个虚拟的 change result 中
  if (thirdPartyItems.length > 0) {
    allChanges.push({
      provider: "third_party",
      detected_at: new Date().toISOString(),
      has_changes: true,
      new_models: [],
      removed_models: [],
      changed_models: [],
      rss_updates: thirdPartyItems,
    });
  }

  // 判断是否有任何变更
  const hasAnyChanges = allChanges.some((c) => c.has_changes);

  if (!hasAnyChanges) {
    console.log("\n[Daily] No changes detected across all providers. Skipping report.");
    // 仍然保存记录（标记为无变更）
    const report: DailyReport = {
      date: today,
      has_changes: false,
      changes: allChanges,
      summary: "No changes detected.",
    };
    saveDailyReport(report);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[Daily] Completed in ${elapsed}s (no notification sent)`);
    return;
  }

  // 5. 生成 LLM 报告
  console.log("\n[Daily] Generating change report with LLM...");
  const changesJson = JSON.stringify(allChanges, null, 2);
  const reportText = await generateDailyReport(changesJson);

  // 6. 保存历史记录
  const report: DailyReport = {
    date: today,
    has_changes: true,
    changes: allChanges,
    summary: reportText,
  };
  saveDailyReport(report);

  // 7. 发送 Slack 通知
  if (!isDryRun) {
    console.log("[Daily] Sending report to Slack...");
    const slackMessage = `## 📡 AI 模型变更日报 · ${today}\n\n${reportText}`;
    await sendToSlack(slackMessage);
  } else {
    console.log("[Daily] DRY RUN - Report preview:");
    console.log("─".repeat(60));
    console.log(reportText);
    console.log("─".repeat(60));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Daily] Completed in ${elapsed}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[Daily] FATAL:", err.message);
    process.exit(1);
  });

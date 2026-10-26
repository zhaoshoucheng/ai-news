/**
 * 每日检测入口
 * 
 * 执行流程：
 * 1. 加载配置
 * 2. 对每个 provider：抓取 RSS + API 模型列表
 * 3. 与历史快照对比，检测变更
 * 4. 如果有变更：生成 LLM 报告 → 发送邮件
 * 5. 保存新快照和历史记录
 * 
 * 调度：每个工作日 13:00（北京时间）执行
 * 参数：
 *   --dry-run            仅检测不发送
 *   --baseline           仅建立基线：更新快照，当天记为无变更，不调用 LLM、不发邮件
 *   --max-age-days=N     临时覆盖 changelog / news / 第三方条目的最大时效（0 表示不限制）
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
import { sendEmail } from "./email.js";
import { saveDailyReport, getRecentRssUrls } from "./storage.js";
import type { ChangeDetectionResult, DailyReport, RssItem } from "./types.js";

const isDryRun = process.argv.includes("--dry-run");
const isBaseline = process.argv.includes("--baseline");

/**
 * 解析 changelog / news / 第三方条目的最大时效（天）。
 * 优先级：--max-age-days=N > config.settings.max_item_age_days > 默认 7 天。
 */
function resolveMaxAgeDays(configValue: number | undefined): number {
  const arg = process.argv.find((a) => a.startsWith("--max-age-days="));
  if (arg) {
    const n = Number(arg.split("=")[1]);
    if (!isNaN(n) && n >= 0) return n;
  }
  return typeof configValue === "number" && configValue >= 0 ? configValue : 7;
}

/**
 * 丢弃发布时间早于 maxAgeDays 天的条目。
 * changelog / 第三方条目按内容 hash 去重，页面改版后旧条目会被误判为新增，
 * 这里用时效兜底，避免一次推送大量旧内容。
 */
function filterByAge(items: RssItem[], maxAgeDays: number, label: string): RssItem[] {
  if (!maxAgeDays || maxAgeDays <= 0) return items;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const kept = items.filter((item) => {
    if (!item.published_at) return true;
    const t = new Date(item.published_at).getTime();
    return isNaN(t) || t >= cutoff;
  });
  if (kept.length < items.length) {
    console.log(`[Daily] ${label} age filter (≤${maxAgeDays}d): ${items.length} → ${kept.length}`);
  }
  return kept;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const today = new Date().toISOString().split("T")[0];

  console.log("═".repeat(60));
  console.log(`[Daily] AI Model Monitor - Daily Check`);
  console.log(`[Daily] Date: ${today}`);
  console.log(`[Daily] Mode: ${isDryRun ? "DRY RUN (no email)" : "PRODUCTION"}`);
  console.log("═".repeat(60));

  const config = loadConfig();
  const recentUrls = getRecentRssUrls();
  const allChanges: ChangeDetectionResult[] = [];
  const maxAgeDays = resolveMaxAgeDays(config.settings.max_item_age_days);
  console.log(`[Daily] Max item age for changelog / news / third-party: ${maxAgeDays > 0 ? `${maxAgeDays} days` : "unlimited"}`);

  for (const provider of config.providers) {
    console.log(`\n── ${provider.name} ──────────────────────────────────`);

    try {
      // 1. 抓取 RSS
      console.log(`[Daily] Fetching RSS for ${provider.name}...`);
      let rssItems = await fetchRssForProvider(provider, config.settings.fetch_window_hours);

      // RSS 去重（排除已处理过的 URL）
      // 只对博客 RSS 按 URL 去重。changelog / news 已在各自模块按条目 ID / slug 去重；
      // changelog 条目共用页面 URL，按 URL 去重会误删同一页面的新条目。
      const beforeDedup = rssItems.length;
      const seenInBatch = new Set<string>();
      rssItems = rssItems.filter((item) => {
        // 同一厂商的多个 RSS 源可能返回同一篇文章（如 OpenAI news / blog）
        if (recentUrls.has(item.url) || seenInBatch.has(item.url)) return false;
        seenInBatch.add(item.url);
        return true;
      });
      if (beforeDedup > rssItems.length) {
        console.log(`[Daily] RSS dedup: ${beforeDedup} → ${rssItems.length}`);
      }

      // 2b. 抓取 Changelog 页面
      console.log(`[Daily] Fetching changelog for ${provider.name}...`);
      try {
        const changelogItems = filterByAge(
          await fetchChangelogForProvider(provider),
          maxAgeDays,
          `${provider.name} changelog`
        );
        rssItems = [...rssItems, ...changelogItems];
      } catch (err: any) {
        console.warn(`[Daily] Changelog fetch failed for ${provider.name}: ${err.message?.slice(0, 100)}`);
      }

      // 2c. 抓取 News 页面
      if (provider.news_pages && provider.news_pages.length > 0) {
        console.log(`[Daily] Fetching news page for ${provider.name}...`);
        try {
          const newsItems = filterByAge(
            await fetchNewsForProvider(provider),
            maxAgeDays,
            `${provider.name} news`
          );
          rssItems = [...rssItems, ...newsItems];
        } catch (err: any) {
          console.warn(`[Daily] News fetch failed for ${provider.name}: ${err.message?.slice(0, 100)}`);
        }
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
    } catch (err: any) {
      console.error(`[Daily] ❌ Error processing ${provider.name}: ${err.message?.slice(0, 150)}`);
      console.error(`[Daily] Skipping ${provider.name}, continuing with next provider...`);
    }
  }

  // ── 第三方数据源 ──────────────────────────────────────────
  let thirdPartyItems: RssItem[] = [];
  if (config.third_party && config.third_party.length > 0) {
    for (const source of config.third_party) {
      console.log(`\n── ${source.name} (Third Party) ──────────────────────────────────`);
      console.log(`[Daily] Fetching changelog for ${source.name}...`);
      const items = filterByAge(await fetchThirdPartyChangelog(source), maxAgeDays, source.name);
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

  // 基线模式：已抓取的条目全部视为已读，不生成报告、不发送邮件。
  // 记录 has_changes=false，周报不会汇总这些条目；rss_updates 仍保留，供 URL 去重使用。
  if (isBaseline) {
    const ignored = allChanges.reduce(
      (n, c) => n + c.rss_updates.length + c.new_models.length + c.removed_models.length + c.changed_models.length,
      0
    );
    saveDailyReport({
      date: today,
      has_changes: false,
      changes: allChanges,
      summary: `Baseline run: ${ignored} items marked as seen, not reported.`,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[Daily] BASELINE - ${ignored} items marked as seen. No report, no email.`);
    console.log(`[Daily] Completed in ${elapsed}s`);
    return;
  }

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

  // 7. 发送邮件通知
  if (!isDryRun) {
    console.log("[Daily] Sending report via email...");
    const body = `## 📡 AI 模型变更日报 · ${today}\n\n${reportText}`;
    await sendEmail({ subject: `[AI 模型监控] 变更日报 · ${today}`, markdown: body });
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

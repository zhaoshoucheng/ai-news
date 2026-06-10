/**
 * 每周总结入口
 * 
 * 执行流程：
 * 1. 读取本周（周一到周五）的所有每日报告
 * 2. 汇总所有变更数据
 * 3. 使用 LLM 生成周报
 * 4. 发送到 Slack
 * 5. 保存周报文件
 * 
 * 调度：每周五下午 20:00 执行
 */

import "dotenv/config";
import { loadDailyReports, saveWeeklyReport } from "./storage.js";
import { generateWeeklyReport } from "./llm.js";
import { sendToSlack } from "./slack.js";

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log("═".repeat(60));
  console.log(`[Weekly] AI Model Monitor - Weekly Summary`);
  console.log(`[Weekly] Generated at: ${new Date().toISOString()}`);
  console.log("═".repeat(60));

  // 计算本周的日期范围（周一到今天/周五）
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  
  // 找到本周一
  const monday = new Date(today);
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(today.getDate() - daysFromMonday);

  const weekStart = monday.toISOString().split("T")[0];
  const weekEnd = today.toISOString().split("T")[0];

  console.log(`[Weekly] Week range: ${weekStart} to ${weekEnd}`);

  // 1. 读取本周所有每日报告
  const dailyReports = loadDailyReports(weekStart, weekEnd);
  console.log(`[Weekly] Found ${dailyReports.length} daily reports`);

  if (dailyReports.length === 0) {
    console.log("[Weekly] No daily reports found for this week. Sending minimal summary.");
    const noDataMessage = `## 📋 AI 模型变更周报 · ${weekStart} ~ ${weekEnd}\n\n本周未检测到任何模型变更。各厂商 API 保持稳定。`;
    await sendToSlack(noDataMessage);
    return;
  }

  // 2. 检查是否有任何变更
  const reportsWithChanges = dailyReports.filter((r) => r.has_changes);
  
  if (reportsWithChanges.length === 0) {
    console.log("[Weekly] No changes detected this week.");
    const noChangesMessage = `## 📋 AI 模型变更周报 · ${weekStart} ~ ${weekEnd}\n\n本周 ${dailyReports.length} 次检测均未发现变更。OpenAI、Anthropic、Google Gemini 的模型和 API 保持稳定。`;
    await sendToSlack(noChangesMessage);
    saveWeeklyReport(weekStart, noChangesMessage);
    return;
  }

  // 3. 汇总数据并生成周报
  console.log(`[Weekly] ${reportsWithChanges.length} days had changes. Generating weekly report...`);

  const weeklyData = {
    week_range: `${weekStart} ~ ${weekEnd}`,
    daily_summaries: dailyReports.map((r) => ({
      date: r.date,
      has_changes: r.has_changes,
      changes: r.changes,
    })),
  };

  const weeklyDataJson = JSON.stringify(weeklyData, null, 2);
  const reportText = await generateWeeklyReport(weeklyDataJson);

  // 4. 发送到 Slack
  console.log("[Weekly] Sending weekly report to Slack...");
  const slackMessage = `## 📋 AI 模型变更周报 · ${weekStart} ~ ${weekEnd}\n\n${reportText}`;
  await sendToSlack(slackMessage);

  // 5. 保存周报
  saveWeeklyReport(weekStart, reportText);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Weekly] Completed in ${elapsed}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[Weekly] FATAL:", err.message);
    process.exit(1);
  });

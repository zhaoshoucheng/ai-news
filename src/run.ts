/**
 * 统一调度入口
 * 
 * 每次被触发时：
 * 1. 执行每日检测（有变更才发邮件）
 * 2. 如果当天是周五，额外执行周报生成
 * 
 * 参数：
 *   --daily-only  仅执行每日检测
 *   --weekly-only 仅执行周报
 *   --dry-run     不发送邮件
 */

import "dotenv/config";
import { execSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dailyOnly = args.includes("--daily-only");
const weeklyOnly = args.includes("--weekly-only");
const dryRun = args.includes("--dry-run");

const repoRoot = resolve(__dirname, "..");

function runScript(scriptName: string, label: string): void {
  try {
    execSync(`bash ${resolve(repoRoot, "scripts", scriptName)}`, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
      timeout: 120000,
    });
  } catch (err: any) {
    console.error(`[Run] ${label} failed: ${err.message}`);
  }
}

async function main(): Promise<void> {
  const today = new Date();
  const isFriday = today.getDay() === 5;
  let dailyFailed = false;
  let weeklyFailed = false;

  // 运行前：从 data-snapshots 分支恢复最新快照（保证去重对比正确）
  if (!dryRun) {
    runScript("restore-snapshots.sh", "Snapshot restore");
  }

  // 备份运行前的快照。抓取阶段会先把新条目 ID 写进快照，再调用 LLM；
  // 如果之后日报失败，需要回滚到这个备份，否则这些条目会被当成"已读"而永久漏报。
  const snapshotsDir = resolve(repoRoot, "data", "snapshots");
  let snapshotBackup: string | null = null;
  if (!dryRun && !weeklyOnly && existsSync(snapshotsDir)) {
    snapshotBackup = join(mkdtempSync(join(tmpdir(), "ai-news-snapshots-")), "snapshots");
    cpSync(snapshotsDir, snapshotBackup, { recursive: true });
  }

  // 执行每日检测
  if (!weeklyOnly) {
    console.log("[Run] Starting daily check...\n");
    try {
      execSync(`npx tsx ${resolve(__dirname, "run-daily.ts")} ${dryRun ? "--dry-run" : ""}`, {
        cwd: resolve(__dirname, ".."),
        stdio: "inherit",
        env: process.env,
        timeout: 1200000, // 含 LLM 限流重试（约 10 分钟）
      });
    } catch (err: any) {
      dailyFailed = true;
      console.error("[Run] Daily check failed:", err.message);
    }
  }

  // 周五额外执行周报（日报失败时跳过：当天数据缺失，周报不完整）
  if ((isFriday || weeklyOnly) && dailyFailed && !dailyOnly) {
    weeklyFailed = true;
    console.error("\n[Run] Skipping weekly summary because the daily check failed (today's data is missing).");
  } else if (isFriday || weeklyOnly) {
    if (!dailyOnly) {
      console.log("\n[Run] It's Friday! Starting weekly summary...\n");
      try {
        execSync(`npx tsx ${resolve(__dirname, "run-weekly.ts")}`, {
          cwd: resolve(__dirname, ".."),
          stdio: "inherit",
          env: process.env,
          timeout: 1200000, // 含 LLM 限流重试（约 10 分钟）
        });
      } catch (err: any) {
        weeklyFailed = true;
        console.error("[Run] Weekly summary failed:", err.message);
      }
    }
  }

  // 运行后：将更新后的快照提交到 data-snapshots 分支（不污染 main）。
  // 日报失败时不提交，并回滚到运行前的快照，让同样的条目在下次运行时重新被检测到。
  if (!dryRun && dailyFailed) {
    if (snapshotBackup) {
      rmSync(snapshotsDir, { recursive: true, force: true });
      cpSync(snapshotBackup, snapshotsDir, { recursive: true });
    }
    console.error(
      "\n[Run] Daily check failed — snapshots rolled back to their pre-run state and NOT committed; the same items will be detected on the next run."
    );
  } else if (!dryRun) {
    console.log("\n[Run] Committing snapshots to data-snapshots branch...");
    runScript("commit-snapshots.sh", "Snapshot commit");
  }
  if (snapshotBackup) rmSync(dirname(snapshotBackup), { recursive: true, force: true });

  if (dailyFailed || weeklyFailed) {
    console.error(
      `\n[Run] Completed with failures (daily: ${dailyFailed ? "FAILED" : "ok"}, weekly: ${weeklyFailed ? "FAILED" : "ok"}).`
    );
    process.exit(1);
  }
  console.log("\n[Run] All tasks completed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Run] FATAL:", err.message);
    process.exit(1);
  });

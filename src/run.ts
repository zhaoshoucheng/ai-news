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
import { resolve, dirname } from "path";
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

  // 运行前：从 data-snapshots 分支恢复最新快照（保证去重对比正确）
  if (!dryRun) {
    runScript("restore-snapshots.sh", "Snapshot restore");
  }

  // 执行每日检测
  if (!weeklyOnly) {
    console.log("[Run] Starting daily check...\n");
    try {
      execSync(`npx tsx ${resolve(__dirname, "run-daily.ts")} ${dryRun ? "--dry-run" : ""}`, {
        cwd: resolve(__dirname, ".."),
        stdio: "inherit",
        env: process.env,
        timeout: 180000,
      });
    } catch (err: any) {
      console.error("[Run] Daily check failed:", err.message);
    }
  }

  // 周五额外执行周报
  if (isFriday || weeklyOnly) {
    if (!dailyOnly) {
      console.log("\n[Run] It's Friday! Starting weekly summary...\n");
      try {
        execSync(`npx tsx ${resolve(__dirname, "run-weekly.ts")}`, {
          cwd: resolve(__dirname, ".."),
          stdio: "inherit",
          env: process.env,
          timeout: 180000,
        });
      } catch (err: any) {
        console.error("[Run] Weekly summary failed:", err.message);
      }
    }
  }

  // 运行后：将更新后的快照提交到 data-snapshots 分支（不污染 main）
  if (!dryRun) {
    console.log("\n[Run] Committing snapshots to data-snapshots branch...");
    runScript("commit-snapshots.sh", "Snapshot commit");
  }

  console.log("\n[Run] All tasks completed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Run] FATAL:", err.message);
    process.exit(1);
  });

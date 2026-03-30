/**
 * 流水线独立运行入口
 * 用于 Manus 定时调度直接调用
 *
 * 使用方式：
 *   node --import tsx/esm run-pipeline.mjs
 * 或通过 tsx：
 *   npx tsx run-pipeline.mjs
 */

import { runPipeline } from "./server/pipeline/index.ts";

runPipeline()
  .then(() => {
    console.log("\n[Runner] Pipeline completed successfully");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n[Runner] Pipeline failed:", err.message);
    process.exit(1);
  });

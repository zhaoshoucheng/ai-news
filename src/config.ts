/**
 * 配置加载模块
 * 从 config/sources.json 读取数据源配置
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { SourceConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export function loadConfig(): SourceConfig {
  const configPath = resolve(PROJECT_ROOT, "config/sources.json");
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as SourceConfig;
}

export function getDataDir(): string {
  return resolve(PROJECT_ROOT, "data");
}

export function getSnapshotsDir(): string {
  return resolve(PROJECT_ROOT, "data/snapshots");
}

export function getHistoryDir(): string {
  return resolve(PROJECT_ROOT, "data/history");
}

export function getWeeklyDir(): string {
  return resolve(PROJECT_ROOT, "data/weekly");
}

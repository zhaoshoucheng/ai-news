/**
 * 快照对比模块
 * 对比新旧模型快照，检测变更
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getSnapshotsDir } from "./config.js";
import type {
  ModelSnapshot,
  ModelInfo,
  ChangeDetectionResult,
  ModelChange,
  FieldChange,
  RssItem,
} from "./types.js";

/**
 * 获取上一次的模型快照
 */
export function loadPreviousSnapshot(providerId: string): ModelSnapshot | null {
  const snapshotPath = resolve(getSnapshotsDir(), `${providerId}.json`);
  if (!existsSync(snapshotPath)) return null;

  try {
    const raw = readFileSync(snapshotPath, "utf-8");
    return JSON.parse(raw) as ModelSnapshot;
  } catch {
    return null;
  }
}

/**
 * 保存当前快照
 */
export function saveSnapshot(snapshot: ModelSnapshot): void {
  const snapshotPath = resolve(getSnapshotsDir(), `${snapshot.provider}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log(`[Snapshot] Saved ${snapshot.provider} snapshot (${snapshot.models.length} models)`);
}

/**
 * 对比两个快照，检测变更
 */
export function detectChanges(
  providerId: string,
  providerName: string,
  oldSnapshot: ModelSnapshot | null,
  newSnapshot: ModelSnapshot,
  rssItems: RssItem[]
): ChangeDetectionResult {
    // 如果没有旧快照（首次运行），模型列表不视为变更（避免首次运行刷屏），但 RSS 更新仍然报告
  if (!oldSnapshot) {
    return {
      provider: providerName,
      detected_at: new Date().toISOString(),
      has_changes: rssItems.length > 0,
      new_models: [],
      removed_models: [],
      changed_models: [],
      rss_updates: rssItems,
    };
  }

  const oldModelsMap = new Map(oldSnapshot.models.map((m) => [m.id, m]));
  const newModelsMap = new Map(newSnapshot.models.map((m) => [m.id, m]));

  // 检测新增模型
  const newModels: ModelInfo[] = [];
  for (const [id, model] of newModelsMap) {
    if (!oldModelsMap.has(id)) {
      newModels.push(model);
    }
  }

  // 检测移除模型
  const removedModels: ModelInfo[] = [];
  for (const [id, model] of oldModelsMap) {
    if (!newModelsMap.has(id)) {
      removedModels.push(model);
    }
  }

  // 检测参数变更
  const changedModels: ModelChange[] = [];
  for (const [id, newModel] of newModelsMap) {
    const oldModel = oldModelsMap.get(id);
    if (!oldModel) continue;

    const changes = compareModels(oldModel, newModel);
    if (changes.length > 0) {
      changedModels.push({ model_id: id, changes });
    }
  }

  const hasChanges =
    newModels.length > 0 ||
    removedModels.length > 0 ||
    changedModels.length > 0 ||
    rssItems.length > 0;

  return {
    provider: providerName,
    detected_at: new Date().toISOString(),
    has_changes: hasChanges,
    new_models: newModels,
    removed_models: removedModels,
    changed_models: changedModels,
    rss_updates: rssItems,
  };
}

/**
 * 对比两个模型的字段差异
 */
function compareModels(oldModel: ModelInfo, newModel: ModelInfo): FieldChange[] {
  const changes: FieldChange[] = [];
  const fieldsToCompare: (keyof ModelInfo)[] = [
    "name",
    "context_window",
    "max_output_tokens",
    "owned_by",
  ];

  for (const field of fieldsToCompare) {
    const oldVal = oldModel[field];
    const newVal = newModel[field];
    if (oldVal !== undefined && newVal !== undefined && JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: String(field), old_value: oldVal, new_value: newVal });
    }
    // 新增了之前没有的字段
    if (oldVal === undefined && newVal !== undefined) {
      changes.push({ field: String(field), old_value: null, new_value: newVal });
    }
  }

  // 对比 pricing
  if (oldModel.pricing && newModel.pricing) {
    if (
      JSON.stringify(oldModel.pricing) !== JSON.stringify(newModel.pricing)
    ) {
      changes.push({
        field: "pricing",
        old_value: oldModel.pricing,
        new_value: newModel.pricing,
      });
    }
  }

  // 对比 capabilities
  if (oldModel.capabilities && newModel.capabilities) {
    const oldCaps = JSON.stringify([...oldModel.capabilities].sort());
    const newCaps = JSON.stringify([...newModel.capabilities].sort());
    if (oldCaps !== newCaps) {
      changes.push({
        field: "capabilities",
        old_value: oldModel.capabilities,
        new_value: newModel.capabilities,
      });
    }
  }

  return changes;
}

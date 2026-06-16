#!/usr/bin/env bash
#
# restore-snapshots.sh
# 在流水线运行前，从远端 data-snapshots 分支恢复最新的 data/ 快照到本地工作区。
# 这样即使在全新的临时 sandbox 中运行，也能读到上次运行后的快照，保证去重对比正确。
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="data-snapshots"

cd "$REPO_DIR"

git fetch origin "$BRANCH" 2>/dev/null || true

if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  echo "[Snapshots] Restoring data/ from origin/$BRANCH ..."
  # 从远端分支检出 data/ 目录覆盖本地（不切换当前分支）
  git checkout "origin/$BRANCH" -- data/ 2>/dev/null || {
    echo "[Snapshots] No data/ found on $BRANCH, starting fresh."
  }
  # 取消暂存，避污染 main 分支的提交（data/ 已被 .gitignore 忽略）
  git reset -q -- data/ 2>/dev/null || true
  echo "[Snapshots] Restore complete."
else
  echo "[Snapshots] Branch '$BRANCH' does not exist yet, starting fresh (first run)."
fi

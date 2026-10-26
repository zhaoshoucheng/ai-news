#!/usr/bin/env bash
#
# restore-snapshots.sh
# 在流水线运行前，从远端 data-snapshots 分支恢复最新的 data/ 快照到本地工作区。
# 这样即使在全新的临时 sandbox 中运行，也能读到上次运行后的快照，保证去重对比正确。
#
# 认证方式：优先从 .env 读取 GITHUB_TOKEN（Fine-grained PAT）。
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="data-snapshots"

cd "$REPO_DIR"

# 从 .env 读取 GitHub 认证信息
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(GITHUB_TOKEN|GITHUB_REPO)=' "$REPO_DIR/.env" || true)
  set +a
fi

PUSH_URL=""
if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPO:-}" ]; then
  PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
fi
REMOTE="${PUSH_URL:-origin}"

git fetch "$REMOTE" "$BRANCH" 2>/dev/null || true
if [ -n "$PUSH_URL" ]; then
  git update-ref "refs/remotes/origin/$BRANCH" FETCH_HEAD 2>/dev/null || true
fi

if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  # 本地数据比远端新时不覆盖。推送失败或未配置 GITHUB_TOKEN 时，远端会停留在旧快照，
  # 覆盖本地会让已推送过的条目再次被判定为新增。
  LOCAL_LATEST="$(ls data/history/*.json 2>/dev/null | xargs -r -n1 basename | sort | tail -1 || true)"
  REMOTE_LATEST="$(git ls-tree --name-only "origin/$BRANCH" data/history/ 2>/dev/null | xargs -r -n1 basename | sort | tail -1 || true)"
  if [ -n "$LOCAL_LATEST" ] && [[ "$LOCAL_LATEST" > "$REMOTE_LATEST" ]]; then
    echo "[Snapshots] Local data (${LOCAL_LATEST%.json}) is newer than origin/$BRANCH (${REMOTE_LATEST:-none}), keeping local."
    exit 0
  fi
  echo "[Snapshots] Restoring data/ from origin/$BRANCH ..."
  # 从远端分支检出 data/ 目录覆盖本地（不切换当前分支）
  git checkout "origin/$BRANCH" -- data/ 2>/dev/null || {
    echo "[Snapshots] No data/ found on $BRANCH, starting fresh."
  }
  # 取消暂存，避免污染 main 分支的提交（data/ 已被 .gitignore 忽略）
  git reset -q -- data/ 2>/dev/null || true
  echo "[Snapshots] Restore complete."
else
  echo "[Snapshots] Branch '$BRANCH' does not exist yet, starting fresh (first run)."
fi

#!/usr/bin/env bash
#
# commit-snapshots.sh
# 将 data/ 目录（快照 + 历史 + 周报）提交到独立的 data-snapshots 分支。
# 该分支与 main 完全隔离，仅用于持久化运行数据以支持跨次运行的去重对比。
# main 分支只保留代码，不含任何运行数据。
#
# 认证方式：优先从 .env 读取 GITHUB_TOKEN（Fine-grained PAT），构造带 token 的
# HTTPS 推送地址，避免依赖会过期的临时凭据。
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="data-snapshots"
WORKTREE_DIR="$(mktemp -d)"
DATE_TAG="$(date +%Y-%m-%d)"

cd "$REPO_DIR"

# 从 .env 读取 GitHub 认证信息
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(GITHUB_TOKEN|GITHUB_REPO)=' "$REPO_DIR/.env" || true)
  set +a
fi

# 计算带认证的推送地址（优先使用 PAT，回退到 origin）
PUSH_URL=""
if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPO:-}" ]; then
  PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
fi
REMOTE="${PUSH_URL:-origin}"

fetch_remote() {
  git fetch "$REMOTE" "$BRANCH" 2>/dev/null || true
  if [ -n "$PUSH_URL" ]; then
    git update-ref "refs/remotes/origin/$BRANCH" FETCH_HEAD 2>/dev/null || true
  fi
}
push_remote() {
  git push "$REMOTE" "$BRANCH" 2>&1 | sed "s#${GITHUB_TOKEN:-__NO_TOKEN__}#***#g" | tail -2
}

# 确保有可提交的数据
if [ ! -d "data" ]; then
  echo "[Snapshots] No data/ directory found, skipping."
  exit 0
fi

# 配置提交身份（与 main 保持一致）
GIT_NAME="$(git config user.name || echo 'AI News Bot')"
GIT_EMAIL="$(git config user.email || echo 'bot@users.noreply.github.com')"

cleanup() {
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
  rm -rf "$WORKTREE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# 获取远端最新的 data-snapshots（如果存在）
fetch_remote

if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  # 远端已有该分支：基于它创建 worktree
  git worktree add --force "$WORKTREE_DIR" "origin/$BRANCH" 2>/dev/null
  cd "$WORKTREE_DIR"
  git checkout -B "$BRANCH" 2>/dev/null
else
  # 远端没有：创建一个全新的孤立分支
  git worktree add --force --detach "$WORKTREE_DIR" 2>/dev/null
  cd "$WORKTREE_DIR"
  git checkout --orphan "$BRANCH" 2>/dev/null
  git rm -rf . 2>/dev/null || true
fi

# 同步 data/ 内容到 worktree
rm -rf "$WORKTREE_DIR/data" 2>/dev/null || true
cp -r "$REPO_DIR/data" "$WORKTREE_DIR/data"

cd "$WORKTREE_DIR"
git add -A data/

if git diff --cached --quiet; then
  echo "[Snapshots] No changes in data/, nothing to commit."
  exit 0
fi

git -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
  commit -m "data: snapshot update ${DATE_TAG}" >/dev/null

push_remote
echo "[Snapshots] Committed and pushed data/ to '$BRANCH' branch (${DATE_TAG})."

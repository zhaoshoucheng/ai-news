/**
 * Slack 推送模块
 * 通过 manus-mcp-cli 调用 Slack API 发送消息
 * 
 * 注意：此模块在 Manus 环境中通过 MCP 工具发送消息
 * 在本地开发时，会将消息输出到控制台
 */

import { execSync } from "child_process";
import { loadConfig } from "./config.js";

const MAX_SLACK_MESSAGE_LENGTH = 4000;

/**
 * 发送消息到 Slack 频道
 */
export async function sendToSlack(message: string): Promise<void> {
  const config = loadConfig();
  const channelId = config.settings.slack_channel_id;

  // 如果消息太长，分段发送
  const chunks = splitMessage(message, MAX_SLACK_MESSAGE_LENGTH);

  for (const chunk of chunks) {
    await sendSlackMessage(channelId, chunk);
    // 多段消息间稍作等待
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * 通过 MCP CLI 发送 Slack 消息
 */
async function sendSlackMessage(channelId: string, message: string): Promise<void> {
  try {
    const input = JSON.stringify({ channel_id: channelId, message });
    const cmd = `manus-mcp-cli tool call slack_send_message --server slack --input '${input.replace(/'/g, "'\\''")}'`;
    
    execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, HOME: process.env.HOME ?? "/home/ubuntu" },
    });

    console.log("[Slack] Message sent successfully");
  } catch (err: any) {
    // 如果 MCP 不可用（本地开发），降级输出到控制台
    console.warn(`[Slack] MCP send failed (${err.message}), printing to console:`);
    console.log("─".repeat(60));
    console.log(message);
    console.log("─".repeat(60));
  }
}

/**
 * 将长消息分割为多段
 */
function splitMessage(message: string, maxLen: number): string[] {
  if (message.length <= maxLen) return [message];

  const chunks: string[] = [];
  const lines = message.split("\n");
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

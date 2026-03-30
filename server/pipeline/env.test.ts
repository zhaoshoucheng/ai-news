/**
 * 环境变量验证测试
 * 确认 Notion 和 Slack 相关的环境变量已正确配置
 */
import { describe, it, expect } from "vitest";
import "dotenv/config";

describe("Environment Variables", () => {
  it("NOTION_TOKEN should be set and start with ntn_ or secret_", () => {
    const token = process.env.NOTION_TOKEN;
    expect(token, "NOTION_TOKEN is not set").toBeTruthy();
    const validPrefix = token!.startsWith("ntn_") || token!.startsWith("secret_");
    expect(validPrefix, "NOTION_TOKEN should start with 'ntn_' (new format) or 'secret_' (legacy)").toBe(true);
  });

  it("NOTION_SOURCES_DB_ID should be set and be a valid UUID-like string", () => {
    const id = process.env.NOTION_SOURCES_DB_ID;
    expect(id, "NOTION_SOURCES_DB_ID is not set").toBeTruthy();
    // Notion DB ID 是 32 位十六进制字符串（可能含连字符）
    expect(id!.replace(/-/g, "").length, "NOTION_SOURCES_DB_ID should be 32 chars").toBe(32);
  });

  it("NOTION_ARTICLES_DB_ID should be set and be a valid UUID-like string", () => {
    const id = process.env.NOTION_ARTICLES_DB_ID;
    expect(id, "NOTION_ARTICLES_DB_ID is not set").toBeTruthy();
    expect(id!.replace(/-/g, "").length, "NOTION_ARTICLES_DB_ID should be 32 chars").toBe(32);
  });

  it("SLACK_WEBHOOK_URL should be set and start with https://hooks.slack.com", () => {
    const url = process.env.SLACK_WEBHOOK_URL;
    expect(url, "SLACK_WEBHOOK_URL is not set").toBeTruthy();
    expect(
      url!.startsWith("https://hooks.slack.com"),
      "SLACK_WEBHOOK_URL should start with https://hooks.slack.com"
    ).toBe(true);
  });
});

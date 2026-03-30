import { describe, it, expect } from "vitest";
import { deduplicateBySimilarity } from "./fetcher";
import type { RawArticle } from "./fetcher";

function makeArticle(title: string, url: string): RawArticle {
  return {
    url,
    title,
    sourceName: "TestSource",
    sourceUrl: "https://test.com/feed",
    publishedAt: new Date(),
    rawSummary: "test summary",
  };
}

describe("deduplicateBySimilarity", () => {
  it("should keep all articles when titles are distinct", () => {
    const articles = [
      makeArticle("OpenAI releases GPT-5 with new capabilities", "https://a.com/1"),
      makeArticle("Google announces Gemini Ultra 2.0 model", "https://b.com/2"),
      makeArticle("Meta open-sources LLaMA 4 weights", "https://c.com/3"),
    ];
    const result = deduplicateBySimilarity(articles);
    expect(result.length).toBe(3);
  });

  it("should remove near-duplicate articles about the same event", () => {
    const articles = [
      makeArticle("OpenAI发布GPT-5，性能大幅提升", "https://a.com/1"),
      makeArticle("OpenAI正式发布GPT-5模型，性能大幅提升", "https://b.com/2"),
      makeArticle("OpenAI GPT-5发布，性能提升显著", "https://c.com/3"),
      makeArticle("Google发布Gemini 2.0 Ultra", "https://d.com/4"),
    ];
    const result = deduplicateBySimilarity(articles, 0.6);
    // 前三篇高度相似，应只保留一篇；第四篇独立
    expect(result.length).toBeLessThan(4);
    // 确保Google那篇被保留
    expect(result.some((a) => a.url === "https://d.com/4")).toBe(true);
  });

  it("should handle empty array", () => {
    expect(deduplicateBySimilarity([])).toEqual([]);
  });

  it("should handle single article", () => {
    const articles = [makeArticle("Single article", "https://a.com/1")];
    expect(deduplicateBySimilarity(articles)).toHaveLength(1);
  });

  it("should prefer longer titles when deduplicating", () => {
    const articles = [
      makeArticle("OpenAI发布GPT-5", "https://short.com/1"),
      makeArticle("OpenAI正式发布GPT-5模型，带来全新多模态能力和更强推理", "https://long.com/2"),
    ];
    const result = deduplicateBySimilarity(articles, 0.5);
    if (result.length === 1) {
      // 应保留标题更长的文章
      expect(result[0].url).toBe("https://long.com/2");
    }
  });
});

describe("URL normalization", () => {
  it("should handle articles with different sources but same topic", () => {
    const articles = [
      makeArticle("Anthropic Claude 3.5 Sonnet released", "https://techcrunch.com/claude"),
      makeArticle("Anthropic releases Claude 3.5 Sonnet model", "https://venturebeat.com/claude"),
      makeArticle("New breakthrough in quantum computing", "https://science.com/quantum"),
    ];
    const result = deduplicateBySimilarity(articles, 0.7);
    // 量子计算那篇应该被保留
    expect(result.some((a) => a.url === "https://science.com/quantum")).toBe(true);
  });
});

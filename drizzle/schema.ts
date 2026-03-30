import {
  float,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * 抓取到的原始文章候选池
 */
export const articles = mysqlTable("articles", {
  id: int("id").autoincrement().primaryKey(),
  url: varchar("url", { length: 2048 }).notNull().unique(),
  title: text("title").notNull(),
  sourceName: varchar("sourceName", { length: 256 }),
  sourceUrl: varchar("sourceUrl", { length: 2048 }),
  publishedAt: timestamp("publishedAt"),
  rawSummary: text("rawSummary"),
  aiSummary: text("aiSummary"),
  qualityScore: float("qualityScore").default(0),
  category: varchar("category", { length: 128 }),
  rankScore: float("rankScore").default(0),
  selectedForReview: int("selectedForReview").default(0),
  writtenToNotion: int("writtenToNotion").default(0),
  notionPageId: varchar("notionPageId", { length: 64 }),
  titleVector: text("titleVector"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Article = typeof articles.$inferSelect;
export type InsertArticle = typeof articles.$inferInsert;

/**
 * 每次流水线运行的日志记录
 */
export const pipelineRuns = mysqlTable("pipeline_runs", {
  id: int("id").autoincrement().primaryKey(),
  status: mysqlEnum("status", ["running", "success", "failed"]).default("running").notNull(),
  fetchedCount: int("fetchedCount").default(0),
  afterUrlDedup: int("afterUrlDedup").default(0),
  afterSimilarDedup: int("afterSimilarDedup").default(0),
  digestCount: int("digestCount").default(0),
  reviewCount: int("reviewCount").default(0),
  errorMessage: text("errorMessage"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
});

export type PipelineRun = typeof pipelineRuns.$inferSelect;

/**
 * 个人画像权重表
 */
export const profileWeights = mysqlTable("profile_weights", {
  id: int("id").autoincrement().primaryKey(),
  dimensionType: mysqlEnum("dimensionType", ["source", "category", "keyword"]).notNull(),
  dimensionValue: varchar("dimensionValue", { length: 256 }).notNull(),
  positiveCount: int("positiveCount").default(0).notNull(),
  negativeCount: int("negativeCount").default(0).notNull(),
  weight: float("weight").default(1.0).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProfileWeight = typeof profileWeights.$inferSelect;

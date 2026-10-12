/**
 * Typecho 导入插件的类型定义。
 *
 * 解析产物、任务状态、导入选项与进度报告都集中在这里，
 * 其余模块只依赖本文件，避免类型在各处各写一份。
 */

/** Typecho 备份里出现的表。 */
export type TypechoTable =
  | 'contents'
  | 'comments'
  | 'metas'
  | 'relationships'
  | 'users'
  | 'fields';

/** 一条记录解码后的原始列值（`null` 表示 SQL NULL，空串表示空字符串）。 */
export type TypechoRow = Record<string, string | null>;

export interface TypechoContent {
  cid: number;
  title: string;
  slug: string;
  /** Unix 秒。 */
  created: number;
  /** Unix 秒。 */
  modified: number;
  text: string;
  order: number;
  authorId: number;
  template: string | null;
  /** post / page / attachment / post_draft / page_draft。 */
  type: string;
  /** publish / draft / hidden。 */
  status: string;
  password: string | null;
  commentsNum: number;
  allowComment: number;
  allowPing: number;
  allowFeed: number;
  parent: number;
}

export interface TypechoComment {
  coid: number;
  cid: number;
  /** Unix 秒。 */
  created: number;
  author: string;
  authorId: number;
  ownerId: number;
  mail: string;
  url: string | null;
  ip: string | null;
  agent: string | null;
  text: string;
  type: string;
  /** approved / pending / spam。 */
  status: string;
  parent: number;
}

export interface TypechoMeta {
  mid: number;
  name: string;
  slug: string;
  /** category / tag。 */
  type: string;
  description: string;
  count: number;
  order: number;
  parent: number;
}

export interface TypechoRelationship {
  cid: number;
  mid: number;
}

export interface TypechoUser {
  uid: number;
  name: string;
  mail: string;
  url: string | null;
  screenName: string;
  created: number;
  group: string;
}

export interface TypechoField {
  cid: number;
  name: string;
  /** str / int / float。 */
  type: string;
  strValue: string;
  intValue: number;
  floatValue: number;
}

/** 附件条目（来自 contents.type = attachment，text 是 PHP serialize 或 JSON）。 */
export interface TypechoAttachment {
  cid: number;
  title: string;
  slug: string;
  created: number;
  status: string;
  /** 原始 `text`（serialize / JSON），解析失败时为 null。 */
  raw: string;
  /** 站点内的相对路径，例如 `/usr/uploads/2025/09/3003830580.avif`。 */
  path: string | null;
  name: string | null;
  mime: string | null;
  size: number | null;
}

export interface BackupStats {
  posts: number;
  pages: number;
  attachments: number;
  categories: number;
  tags: number;
  comments: number;
  relationships: number;
  fields: number;
  users: number;
  /** 正文中被判定为 HTML、需要转换的条数。 */
  htmlContents: number;
  /** 正文本身就是 Markdown 的条数。 */
  markdownContents: number;
}

export interface ParsedBackup {
  fileName: string;
  fileSize: number;
  contents: TypechoContent[];
  comments: TypechoComment[];
  metas: TypechoMeta[];
  relationships: TypechoRelationship[];
  users: TypechoUser[];
  fields: TypechoField[];
  attachments: TypechoAttachment[];
  stats: BackupStats;
  warnings: string[];
}

/** 界面可勾选的导入范围。 */
export interface ImportInclude {
  terms: boolean;
  posts: boolean;
  pages: boolean;
  comments: boolean;
  attachments: boolean;
  fields: boolean;
}

export interface ImportOptions {
  include: ImportInclude;
  /** 内容归属的作者（RiceNote 用户 ID）。 */
  authorId: number;
  /** 只统计不落库。 */
  dryRun: boolean;
  excerptLength: number;
  /** 是否尝试从源站下载附件（需要插件设置里的 originBaseUrl）。 */
  downloadAttachments: boolean;
}

export type ImportPhase =
  | 'pending'
  | 'terms'
  | 'posts'
  | 'pages'
  | 'timestamps'
  | 'comments'
  | 'fields'
  | 'attachments'
  | 'done'
  | 'failed';

export interface ImportFailure {
  sourceType: 'meta' | 'post' | 'page' | 'comment' | 'attachment' | 'field';
  sourceId: number;
  title?: string;
  reason: string;
}

export interface ImportCounters {
  terms: number;
  posts: number;
  pages: number;
  comments: number;
  attachments: number;
  fields: number;
  skipped: number;
}

export interface JobProgress {
  phase: ImportPhase;
  processed: number;
  total: number;
  counters: ImportCounters;
  failures: ImportFailure[];
}

export type JobStatus = 'parsed' | 'running' | 'done' | 'failed' | 'canceled' | 'rolled_back';

export interface ImportJob {
  id: number;
  siteId: string;
  fileName: string;
  fileSize: number;
  status: JobStatus;
  stats: BackupStats;
  warnings: string[];
  options: ImportOptions;
  progress: JobProgress;
  operatorId: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 后台列表与详情页使用的精简任务视图。 */
export interface JobSummary {
  id: number;
  fileName: string;
  fileSize: number;
  status: JobStatus;
  stats: BackupStats;
  options: ImportOptions;
  counters: ImportCounters;
  createdAt: string;
  updatedAt: string;
}

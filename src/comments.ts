/**
 * 评论导入：直接写入 `rn_comments`。
 *
 * 之所以直写：comments 插件只提供前台 `submit()`（作者、时间、状态都由插件自己决定）
 * 与后台审核接口，没有"按指定作者/时间/状态批量创建"的契约，迁移场景无法使用。
 *
 * 复现 comments 插件的两条规则，保证数据口径一致：
 * - `ip_hash` = `sha256(siteId|comment|ip)`（只用于反垃圾比对，不可还原）；
 * - 先插入全部评论拿到 `coid → id` 映射，再回填 `parent_id`（楼中楼回复要跨行引用）。
 */

import { createHash } from 'node:crypto';
import type { PluginDatabase } from '@ricenote/plugin-sdk';
import type { TypechoComment } from './types.js';

export type CommentStatus = 'pending' | 'approved' | 'spam' | 'trash';

export interface CommentImportItem {
  coid: number;
  postId: number;
  parentCoid: number;
  authorName: string;
  authorEmail: string;
  authorUrl: string | null;
  content: string;
  status: CommentStatus;
  ip: string | null;
  agent: string | null;
  createdAt: Date;
}

const URL_MAX = 300;
const NAME_MAX = 80;
const EMAIL_MAX = 160;
const REQUIRED_COLUMNS = [
  'post_id',
  'parent_id',
  'author_name',
  'author_email',
  'author_url',
  'content',
  'status',
  'ip_hash',
  'user_agent',
  'created_at',
  'updated_at'
] as const;

/** `rn_comments` 是否仍具备导入所需的列。 */
export async function hasCommentColumns(db: PluginDatabase, table: string): Promise<boolean> {
  const rows = await db.query<{ total: number }>(
    `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (${REQUIRED_COLUMNS.map(
        () => '?'
      ).join(', ')})`,
    [table, ...REQUIRED_COLUMNS]
  );
  return Number(rows[0]?.total ?? 0) === REQUIRED_COLUMNS.length;
}

/**
 * 插入评论并回填父子关系，返回 `coid → commentId`。
 *
 * 父评论不存在（例如父评论属于被跳过的页面）时降级为一级评论，不丢内容。
 */
export async function insertComments(
  db: PluginDatabase,
  table: string,
  siteId: string,
  items: CommentImportItem[]
): Promise<Map<number, number>> {
  const mapping = new Map<number, number>();
  if (items.length === 0) return mapping;

  const pendingParents: Array<{ id: number; parentCoid: number }> = [];

  for (const item of items) {
    const result = await db.execute(
      `INSERT INTO ${table}
         (site_id, post_id, parent_id, user_id, author_name, author_email, author_url,
          content, status, ip_hash, user_agent, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        siteId,
        item.postId,
        truncate(item.authorName, NAME_MAX),
        truncate(item.authorEmail, EMAIL_MAX),
        item.authorUrl ? truncate(item.authorUrl, URL_MAX) : null,
        item.content,
        item.status,
        hashSource(item.ip, siteId),
        item.agent ? truncate(item.agent, URL_MAX) : null,
        item.createdAt,
        item.createdAt
      ]
    );
    const id = result.insertId;
    if (id > 0) {
      mapping.set(item.coid, id);
      if (item.parentCoid > 0) pendingParents.push({ id, parentCoid: item.parentCoid });
    }
  }

  for (const { id, parentCoid } of pendingParents) {
    const parentId = mapping.get(parentCoid);
    if (parentId === undefined) continue;
    await db.execute(`UPDATE ${table} SET parent_id = ? WHERE id = ? AND site_id = ?`, [
      parentId,
      id,
      siteId
    ]);
  }

  return mapping;
}

/**
 * Typecho 评论状态 → RiceNote 状态。
 *
 * 含 `[secret]` 的私密评论在 Typecho 里只有登录者可见，
 * 这里一律降为待审核，避免把私密内容直接公开。
 */
export function commentStatusOf(comment: TypechoComment): CommentStatus {
  const text = comment.text ?? '';
  if (text.includes('[secret]')) return 'pending';
  switch (comment.status) {
    case 'approved':
      return 'approved';
    case 'spam':
      return 'spam';
    case 'trash':
      return 'trash';
    default:
      return 'pending';
  }
}

/** 与 comments 插件一致的加盐哈希：`sha256(siteId|comment|ip)`。 */
function hashSource(ip: string | null, siteId: string): string | null {
  const value = (ip ?? '').trim();
  if (value.length === 0) return null;
  return createHash('sha256').update(`${siteId}|comment|${value}`).digest('hex');
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

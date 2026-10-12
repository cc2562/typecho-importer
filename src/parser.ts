/**
 * Typecho `.dat` 备份解析器。
 *
 * 文件格式（按真实备份逐字节逆向得到）：
 *
 * ```
 * %TYPECHO_BACKUP_0001%                      <- 21 字节头
 *   记录 = [1B 表序号][1B 0x00]
 *          [2B LE uint16 JSON 头长度][4B LE uint32 值区长度]
 *          [JSON 头：{列名: 值字节长度 或 null}]
 *          [值区：各列值按长度依次拼接；null 列不占字节]
 *          [32B ASCII 校验串]
 * %TYPECHO_BACKUP_0001%                      <- 尾部重复一次头，作为结束标志
 * ```
 *
 * **必须顺序解析**：正文里的 WordPress 块属性（`{"id":12,"sizeSlug":"large"}`）
 * 与记录头长得一模一样，全文搜索 `{` 会产生上千个误命中。
 */

import { tryParsePhpSerialize } from './php-serialize.js';
import { hasMarkdownMarker } from './content-normalize.js';
import type {
  BackupStats,
  ParsedBackup,
  TypechoAttachment,
  TypechoComment,
  TypechoContent,
  TypechoField,
  TypechoMeta,
  TypechoRelationship,
  TypechoRow,
  TypechoTable,
  TypechoUser
} from './types.js';

const MAGIC = '%TYPECHO_BACKUP_0001%';
const MAGIC_LENGTH = 21;
const CHECKSUM_LENGTH = 32;
const RECORD_HEADER_LENGTH = 8;

/** 备份结构异常（不是合法 Typecho 备份 / 记录错位）。 */
export class BackupFormatError extends Error {}

/** 表序号 → 表名的经验映射（不同版本 Typecho 的导出顺序一致）。 */
const TABLE_BY_INDEX: Record<number, TypechoTable> = {
  1: 'contents',
  2: 'comments',
  3: 'metas',
  4: 'relationships',
  5: 'users',
  6: 'fields'
};

export function parseBackup(buffer: Buffer, fileName: string): ParsedBackup {
  const magicBytes = Buffer.from(MAGIC, 'latin1');
  if (buffer.length < MAGIC_LENGTH || !buffer.subarray(0, MAGIC_LENGTH).equals(magicBytes)) {
    throw new BackupFormatError('文件头部不是 %TYPECHO_BACKUP_0001%，请确认这是 Typecho 导出的备份文件');
  }

  const warnings: string[] = [];
  const contents: TypechoContent[] = [];
  const comments: TypechoComment[] = [];
  const metas: TypechoMeta[] = [];
  const relationships: TypechoRelationship[] = [];
  const users: TypechoUser[] = [];
  const fields: TypechoField[] = [];
  const attachments: TypechoAttachment[] = [];
  const unknownTables = new Set<number>();

  let position = MAGIC_LENGTH;
  let recordIndex = 0;

  while (position + RECORD_HEADER_LENGTH <= buffer.length) {
    // 尾部再次出现 magic 表示记录流结束。
    if (buffer.subarray(position, position + MAGIC_LENGTH).equals(magicBytes)) break;

    const tableIndex = buffer[position] as number;
    const headerLength = buffer.readUInt16LE(position + 2);
    const valueLength = buffer.readUInt32LE(position + 4);
    const headerStart = position + RECORD_HEADER_LENGTH;
    const valueStart = headerStart + headerLength;
    const checksumStart = valueStart + valueLength;
    const recordEnd = checksumStart + CHECKSUM_LENGTH;

    if (headerLength === 0 || recordEnd > buffer.length) {
      warnings.push(`第 ${recordIndex + 1} 条记录长度越界，解析到此为止`);
      break;
    }

    const row = decodeRow(buffer, headerStart, headerLength, valueStart, valueLength, warnings, recordIndex);
    const table = TABLE_BY_INDEX[tableIndex] ?? detectTableByColumns(Object.keys(row));

    if (table === undefined) {
      unknownTables.add(tableIndex);
    } else {
      switch (table) {
        case 'contents': {
          const content = toContent(row);
          if (content.type === 'attachment') {
            attachments.push(toAttachment(content));
          } else {
            contents.push(content);
          }
          break;
        }
        case 'comments':
          comments.push(toComment(row));
          break;
        case 'metas':
          metas.push(toMeta(row));
          break;
        case 'relationships':
          relationships.push(toRelationship(row));
          break;
        case 'users':
          users.push(toUser(row));
          break;
        case 'fields':
          fields.push(toField(row));
          break;
      }
    }

    position = recordEnd;
    recordIndex += 1;
  }

  if (recordIndex === 0) {
    throw new BackupFormatError('备份文件里没有解析到任何记录');
  }
  if (unknownTables.size > 0) {
    warnings.push(`存在未知表序号的记录，已跳过：${[...unknownTables].sort().join('、')}`);
  }

  return {
    fileName,
    fileSize: buffer.length,
    contents,
    comments,
    metas,
    relationships,
    users,
    fields,
    attachments,
    stats: buildStats(contents, metas, comments, relationships, fields, users, attachments),
    warnings
  };
}

/**
 * 解码单条记录：JSON 头给出「列名 → 值长度」，值区按顺序拼接。
 *
 * JSON 里写 `null` 表示 SQL NULL（不占字节），写 `0` 表示空字符串。
 */
function decodeRow(
  buffer: Buffer,
  headerStart: number,
  headerLength: number,
  valueStart: number,
  valueLength: number,
  warnings: string[],
  recordIndex: number
): TypechoRow {
  const headerJson = buffer.subarray(headerStart, headerStart + headerLength).toString('utf8');
  let header: unknown;
  try {
    header = JSON.parse(headerJson) as unknown;
  } catch {
    throw new BackupFormatError(`第 ${recordIndex + 1} 条记录的字段头不是合法 JSON`);
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new BackupFormatError(`第 ${recordIndex + 1} 条记录的字段头不是对象`);
  }

  const row: TypechoRow = {};
  let offset = valueStart;
  for (const [column, rawLength] of Object.entries(header as Record<string, unknown>)) {
    if (rawLength === null) {
      row[column] = null;
      continue;
    }
    const length = typeof rawLength === 'number' ? rawLength : Number(rawLength);
    if (!Number.isInteger(length) || length < 0 || offset + length > valueStart + valueLength) {
      throw new BackupFormatError(`第 ${recordIndex + 1} 条记录的字段 ${column} 长度非法`);
    }
    row[column] = buffer.subarray(offset, offset + length).toString('utf8');
    offset += length;
  }

  if (offset !== valueStart + valueLength) {
    warnings.push(`第 ${recordIndex + 1} 条记录存在 ${valueStart + valueLength - offset} 字节未使用的数据`);
  }
  return row;
}

/** 列签名兜底识别表（表序号缺失或版本差异时使用）。 */
function detectTableByColumns(columns: string[]): TypechoTable | undefined {
  if (columns.includes('coid')) return 'comments';
  if (columns.includes('uid')) return 'users';
  if (columns.includes('mid') && columns.includes('type')) return 'metas';
  if (columns.includes('cid') && columns.includes('mid')) return 'relationships';
  if (columns.includes('cid') && columns.includes('str_value')) return 'fields';
  if (columns.includes('cid') && columns.includes('text')) return 'contents';
  return undefined;
}

/* --------------------------------- 行映射 --------------------------------- */

function text(row: TypechoRow, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? '' : value;
}

function int(row: TypechoRow, column: string, fallback = 0): number {
  const value = Number(text(row, column));
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function nullableText(row: TypechoRow, column: string): string | null {
  return row[column] ?? null;
}

function toContent(row: TypechoRow): TypechoContent {
  return {
    cid: int(row, 'cid'),
    title: text(row, 'title'),
    slug: text(row, 'slug'),
    created: int(row, 'created'),
    modified: int(row, 'modified'),
    text: text(row, 'text'),
    order: int(row, 'order'),
    authorId: int(row, 'authorId'),
    template: nullableText(row, 'template'),
    type: text(row, 'type') || 'post',
    status: text(row, 'status') || 'publish',
    password: nullableText(row, 'password'),
    commentsNum: int(row, 'commentsNum'),
    allowComment: int(row, 'allowComment', 1),
    allowPing: int(row, 'allowPing'),
    allowFeed: int(row, 'allowFeed', 1),
    parent: int(row, 'parent')
  };
}

function toComment(row: TypechoRow): TypechoComment {
  return {
    coid: int(row, 'coid'),
    cid: int(row, 'cid'),
    created: int(row, 'created'),
    author: text(row, 'author'),
    authorId: int(row, 'authorId'),
    ownerId: int(row, 'ownerId'),
    mail: text(row, 'mail'),
    url: nullableText(row, 'url'),
    ip: nullableText(row, 'ip'),
    agent: nullableText(row, 'agent'),
    text: text(row, 'text'),
    type: text(row, 'type') || 'comment',
    status: text(row, 'status') || 'approved',
    parent: int(row, 'parent')
  };
}

function toMeta(row: TypechoRow): TypechoMeta {
  return {
    mid: int(row, 'mid'),
    name: text(row, 'name'),
    slug: text(row, 'slug'),
    type: text(row, 'type') || 'category',
    description: text(row, 'description'),
    count: int(row, 'count'),
    order: int(row, 'order'),
    parent: int(row, 'parent')
  };
}

function toRelationship(row: TypechoRow): TypechoRelationship {
  return { cid: int(row, 'cid'), mid: int(row, 'mid') };
}

function toUser(row: TypechoRow): TypechoUser {
  return {
    uid: int(row, 'uid'),
    name: text(row, 'name'),
    mail: text(row, 'mail'),
    url: nullableText(row, 'url'),
    screenName: text(row, 'screenName'),
    created: int(row, 'created'),
    group: text(row, 'group')
  };
}

function toField(row: TypechoRow): TypechoField {
  return {
    cid: int(row, 'cid'),
    name: text(row, 'name'),
    type: text(row, 'type') || 'str',
    strValue: text(row, 'str_value'),
    intValue: int(row, 'int_value'),
    floatValue: Number(text(row, 'float_value')) || 0
  };
}

/**
 * 附件条目：`text` 可能是 PHP 序列化串（老数据）或 JSON（新数据）。
 *
 * 两种都要支持，解析失败时保留 path 为 null，由导入阶段跳过并记告警。
 */
function toAttachment(content: TypechoContent): TypechoAttachment {
  const meta = parseAttachmentMeta(content.text);
  return {
    cid: content.cid,
    title: content.title,
    slug: content.slug,
    created: content.created,
    status: content.status,
    raw: content.text,
    path: meta?.path ?? null,
    name: meta?.name ?? null,
    mime: meta?.mime ?? null,
    size: meta?.size ?? null
  };
}

interface AttachmentMeta {
  path: string | null;
  name: string | null;
  mime: string | null;
  size: number | null;
}

function parseAttachmentMeta(raw: string): AttachmentMeta | undefined {
  const source = raw.trim();
  if (source.length === 0) return undefined;

  const parsed = source.startsWith('{') ? tryParseJson(source) : tryParsePhpSerialize(source);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  return {
    path: firstString(record, ['path']),
    name: firstString(record, ['name']),
    mime: firstString(record, ['mime']),
    size: firstNumber(record, ['size'])
  };
}

function tryParseJson(source: string): unknown | undefined {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/* --------------------------------- 统计 --------------------------------- */

function buildStats(
  contents: TypechoContent[],
  metas: TypechoMeta[],
  comments: TypechoComment[],
  relationships: TypechoRelationship[],
  fields: TypechoField[],
  users: TypechoUser[],
  attachments: TypechoAttachment[]
): BackupStats {
  let posts = 0;
  let pages = 0;
  let markdownContents = 0;
  let htmlContents = 0;

  for (const content of contents) {
    if (content.type === 'page' || content.type === 'page_draft') pages += 1;
    else posts += 1;

    if (hasMarkdownMarker(content.text)) markdownContents += 1;
    else htmlContents += 1;
  }

  let categories = 0;
  let tags = 0;
  for (const meta of metas) {
    if (meta.type === 'tag') tags += 1;
    else categories += 1;
  }

  return {
    posts,
    pages,
    attachments: attachments.length,
    categories,
    tags,
    comments: comments.length,
    relationships: relationships.length,
    fields: fields.length,
    users: users.length,
    htmlContents,
    markdownContents
  };
}

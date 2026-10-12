/**
 * 自有表读写。
 *
 * 表名一律通过 `ctx.db.table()` 生成（→ `rn_typecho_importer_*`），
 * 不跨插件访问任何表；结构化字段以 JSON 文本存放，读取时统一做容错解析。
 */

import type { PluginDatabase } from '@ricenote/plugin-sdk';
import type {
  BackupStats,
  ImportCounters,
  ImportJob,
  ImportOptions,
  JobStatus,
  JobSummary,
  JobProgress,
  TypechoField
} from './types.js';

export type MapSourceType = 'meta' | 'post' | 'page' | 'comment' | 'attachment' | 'field';

export interface MapEntry {
  sourceType: MapSourceType;
  sourceId: number;
  targetId: number | null;
  label?: string;
}

export interface MapRow {
  sourceType: MapSourceType;
  sourceId: number;
  targetId: number | null;
  label: string | null;
}

interface JobRow {
  id: number;
  site_id: string;
  file_name: string;
  file_size: number | string;
  status: string;
  payload: Buffer | null;
  stats_json: string | null;
  options_json: string | null;
  progress_json: string | null;
  warnings_json: string | null;
  error: string | null;
  operator_id: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateJobInput {
  siteId: string;
  fileName: string;
  fileSize: number;
  payload: Buffer;
  stats: BackupStats;
  options: ImportOptions;
  warnings: string[];
  operatorId: number | null;
}

const EMPTY_COUNTERS: ImportCounters = {
  terms: 0,
  posts: 0,
  pages: 0,
  comments: 0,
  attachments: 0,
  fields: 0,
  skipped: 0
};

export function createRepository(db: PluginDatabase) {
  const jobs = db.table('typecho_importer_jobs');
  const maps = db.table('typecho_importer_maps');
  const fieldsTable = db.table('typecho_importer_fields');

  return {
    /** 新建任务，返回自增 ID。 */
    async createJob(input: CreateJobInput): Promise<number> {
      const result = await db.execute(
        `INSERT INTO ${jobs}
           (site_id, file_name, file_size, status, payload, stats_json, options_json, progress_json,
            warnings_json, operator_id, created_at, updated_at)
         VALUES (?, ?, ?, 'parsed', ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          input.siteId,
          input.fileName,
          input.fileSize,
          input.payload,
          JSON.stringify(input.stats),
          JSON.stringify(input.options),
          JSON.stringify(defaultProgress()),
          JSON.stringify(input.warnings),
          input.operatorId
        ]
      );
      return result.insertId;
    },

    /** 读取任务（不含原始备份内容）。 */
    async getJob(id: number): Promise<ImportJob | undefined> {
      const rows = await db.query<JobRow>(
        `SELECT id, site_id, file_name, file_size, status, stats_json, options_json, progress_json,
                warnings_json, error, operator_id, created_at, updated_at
           FROM ${jobs} WHERE id = ?`,
        [id]
      );
      const row = rows[0];
      return row ? mapJob(row) : undefined;
    },

    /** 读取任务附带的原始备份内容（执行阶段才需要，避免列表查询拖着 BLOB）。 */
    async getPayload(id: number): Promise<Buffer | null> {
      const rows = await db.query<{ payload: Buffer | null }>(
        `SELECT payload FROM ${jobs} WHERE id = ?`,
        [id]
      );
      return rows[0]?.payload ?? null;
    },

    /** 最近任务（列表页）。 */
    async listJobs(limit: number): Promise<JobSummary[]> {
      const rows = await db.query<JobRow>(
        `SELECT id, site_id, file_name, file_size, status, stats_json, options_json, progress_json,
                warnings_json, error, operator_id, created_at, updated_at
           FROM ${jobs} ORDER BY id DESC LIMIT ?`,
        [Math.max(1, Math.min(100, limit))]
      );
      return rows.map((row) => {
        const job = mapJob(row);
        return {
          id: job.id,
          fileName: job.fileName,
          fileSize: job.fileSize,
          status: job.status,
          stats: job.stats,
          options: job.options,
          counters: job.progress.counters,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt
        };
      });
    },

    /** 更新进度（执行中高频调用，只写这一列）。 */
    async updateProgress(id: number, progress: JobProgress): Promise<void> {
      await db.execute(`UPDATE ${jobs} SET progress_json = ?, updated_at = NOW() WHERE id = ?`, [
        JSON.stringify(progress),
        id
      ]);
    },

    /** 更新状态与选项（执行开始时写入最终选项）。 */
    async updateStatus(
      id: number,
      status: JobStatus,
      patch: { options?: ImportOptions; error?: string | null } = {}
    ): Promise<void> {
      const assignments = ['status = ?', 'updated_at = NOW()'];
      const params: unknown[] = [status];
      if (patch.options !== undefined) {
        assignments.push('options_json = ?');
        params.push(JSON.stringify(patch.options));
      }
      if (patch.error !== undefined) {
        assignments.push('error = ?');
        params.push(patch.error);
      }
      params.push(id);
      await db.execute(`UPDATE ${jobs} SET ${assignments.join(', ')} WHERE id = ?`, params);
    },

    /** 记录映射（幂等依据与撤销依据）。 */
    async saveMaps(siteId: string, jobId: number, entries: MapEntry[]): Promise<void> {
      if (entries.length === 0) return;
      // 一次 200 条，避免单条 SQL 参数过多。
      for (let index = 0; index < entries.length; index += 200) {
        const batch = entries.slice(index, index + 200);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, NOW())').join(', ');
        const params: unknown[] = [];
        for (const entry of batch) {
          params.push(jobId, siteId, entry.sourceType, entry.sourceId, entry.targetId, entry.label ?? null);
        }
        await db.execute(
          `INSERT INTO ${maps}
             (job_id, site_id, source_type, source_id, target_id, label, created_at)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE target_id = VALUES(target_id), label = VALUES(label)`,
          params
        );
      }
    },

    /** 读取某任务的映射，返回 `sourceId → targetId`。 */
    async loadMaps(jobId: number, sourceType?: MapSourceType): Promise<Map<number, number>> {
      const rows = await db.query<MapRow>(
        `SELECT source_type AS sourceType, source_id AS sourceId, target_id AS targetId, label
           FROM ${maps} WHERE job_id = ? ${sourceType ? 'AND source_type = ?' : ''}`,
        sourceType ? [jobId, sourceType] : [jobId]
      );
      const result = new Map<number, number>();
      for (const row of rows) {
        if (row.targetId !== null) result.set(Number(row.sourceId), Number(row.targetId));
      }
      return result;
    },

    /** 撤销时需要按类型拿到全部目标 ID。 */
    async loadMapRows(jobId: number): Promise<MapRow[]> {
      return db.query<MapRow>(
        `SELECT source_type AS sourceType, source_id AS sourceId, target_id AS targetId, label
           FROM ${maps} WHERE job_id = ? ORDER BY id`,
        [jobId]
      );
    },

    /** 删除某任务的映射（撤销完成后调用）。 */
    async deleteMaps(jobId: number): Promise<void> {
      await db.execute(`DELETE FROM ${maps} WHERE job_id = ?`, [jobId]);
    },

    /** 保存 Typecho 自定义字段（仅备查，不参与主题字段校验）。 */
    async saveFields(siteId: string, jobId: number, entries: TypechoField[]): Promise<void> {
      if (entries.length === 0) return;
      for (let index = 0; index < entries.length; index += 200) {
        const batch = entries.slice(index, index + 200);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, NOW())').join(', ');
        const params: unknown[] = [];
        for (const entry of batch) {
          params.push(
            jobId,
            siteId,
            entry.cid,
            entry.name,
            entry.type,
            entry.strValue,
            entry.intValue,
            entry.floatValue
          );
        }
        await db.execute(
          `INSERT INTO ${fieldsTable}
             (job_id, site_id, cid, name, type, str_value, int_value, float_value, created_at)
           VALUES ${placeholders}`,
          params
        );
      }
    },

    /** 读取某任务保存的自定义字段（按 cid 分组便于回查封面）。 */
    async loadFields(jobId: number): Promise<TypechoField[]> {
      const rows = await db.query<{
        cid: number;
        name: string;
        type: string;
        str_value: string | null;
        int_value: number | null;
        float_value: number | null;
      }>(
        `SELECT cid, name, type, str_value, int_value, float_value
           FROM ${fieldsTable} WHERE job_id = ? ORDER BY cid, id`,
        [jobId]
      );
      return rows.map((row) => ({
        cid: Number(row.cid),
        name: row.name,
        type: row.type,
        strValue: row.str_value ?? '',
        intValue: Number(row.int_value ?? 0),
        floatValue: Number(row.float_value ?? 0)
      }));
    },

    /** 撤销后清掉字段记录。 */
    async deleteFields(jobId: number): Promise<void> {
      await db.execute(`DELETE FROM ${fieldsTable} WHERE job_id = ?`, [jobId]);
    }
  };
}

export type ImporterRepository = ReturnType<typeof createRepository>;

export function defaultProgress(): JobProgress {
  return {
    phase: 'pending',
    processed: 0,
    total: 0,
    counters: { ...EMPTY_COUNTERS },
    failures: []
  };
}

export function emptyCounters(): ImportCounters {
  return { ...EMPTY_COUNTERS };
}

function mapJob(row: JobRow): ImportJob {
  return {
    id: Number(row.id),
    siteId: row.site_id,
    fileName: row.file_name,
    fileSize: Number(row.file_size ?? 0),
    status: (row.status ?? 'parsed') as JobStatus,
    stats: parseJson<BackupStats>(row.stats_json, emptyStats()),
    warnings: parseJson<string[]>(row.warnings_json, []),
    options: parseJson<ImportOptions>(row.options_json, defaultOptions()),
    progress: parseJson<JobProgress>(row.progress_json, defaultProgress()),
    operatorId: row.operator_id === null ? null : Number(row.operator_id),
    error: row.error,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function emptyStats(): BackupStats {
  return {
    posts: 0,
    pages: 0,
    attachments: 0,
    categories: 0,
    tags: 0,
    comments: 0,
    relationships: 0,
    fields: 0,
    users: 0,
    htmlContents: 0,
    markdownContents: 0
  };
}

function defaultOptions(): ImportOptions {
  return {
    include: { terms: true, posts: true, pages: true, comments: true, attachments: false, fields: true },
    authorId: 0,
    dryRun: false,
    excerptLength: 120,
    downloadAttachments: false
  };
}

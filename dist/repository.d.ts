/**
 * 自有表读写。
 *
 * 表名一律通过 `ctx.db.table()` 生成（→ `rn_typecho_importer_*`），
 * 不跨插件访问任何表；结构化字段以 JSON 文本存放，读取时统一做容错解析。
 */
import type { PluginDatabase } from '@ricenote/plugin-sdk';
import type { BackupStats, ImportCounters, ImportJob, ImportOptions, JobStatus, JobSummary, JobProgress, TypechoField } from './types.js';
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
export declare function createRepository(db: PluginDatabase): {
    /** 新建任务，返回自增 ID。 */
    createJob(input: CreateJobInput): Promise<number>;
    /** 读取任务（不含原始备份内容）。 */
    getJob(id: number): Promise<ImportJob | undefined>;
    /** 读取任务附带的原始备份内容（执行阶段才需要，避免列表查询拖着 BLOB）。 */
    getPayload(id: number): Promise<Buffer | null>;
    /** 最近任务（列表页）。 */
    listJobs(limit: number): Promise<JobSummary[]>;
    /** 更新进度（执行中高频调用，只写这一列）。 */
    updateProgress(id: number, progress: JobProgress): Promise<void>;
    /** 更新状态与选项（执行开始时写入最终选项）。 */
    updateStatus(id: number, status: JobStatus, patch?: {
        options?: ImportOptions;
        error?: string | null;
    }): Promise<void>;
    /** 记录映射（幂等依据与撤销依据）。 */
    saveMaps(siteId: string, jobId: number, entries: MapEntry[]): Promise<void>;
    /** 读取某任务的映射，返回 `sourceId → targetId`。 */
    loadMaps(jobId: number, sourceType?: MapSourceType): Promise<Map<number, number>>;
    /** 撤销时需要按类型拿到全部目标 ID。 */
    loadMapRows(jobId: number): Promise<MapRow[]>;
    /** 删除某任务的映射（撤销完成后调用）。 */
    deleteMaps(jobId: number): Promise<void>;
    /** 保存 Typecho 自定义字段（仅备查，不参与主题字段校验）。 */
    saveFields(siteId: string, jobId: number, entries: TypechoField[]): Promise<void>;
    /** 读取某任务保存的自定义字段（按 cid 分组便于回查封面）。 */
    loadFields(jobId: number): Promise<TypechoField[]>;
    /** 撤销后清掉字段记录。 */
    deleteFields(jobId: number): Promise<void>;
};
export type ImporterRepository = ReturnType<typeof createRepository>;
export declare function defaultProgress(): JobProgress;
export declare function emptyCounters(): ImportCounters;
//# sourceMappingURL=repository.d.ts.map
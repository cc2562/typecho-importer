/**
 * 回填文章 / 页面的创建、更新与发布时间。
 *
 * 为什么需要直接写库：posts 与 pages 的保存契约不接受时间参数
 * （`INSERT` 里写死 `NOW()`，`published_at` 只在转为发布态时补写），
 * 而迁移必须保留原站的时间线，否则几百篇文章会全部挤在导入当天。
 *
 * 安全阀：写入前先用 `information_schema.COLUMNS` 校验目标列仍然存在，
 * 官方插件升级后若列名变更，这里降级为「不改时间」并告警，而不是让任务失败。
 */
import type { PluginDatabase } from '@ricenote/plugin-sdk';
export interface TimestampEntry {
    id: number;
    createdAt: Date;
    updatedAt: Date;
    publishedAt: Date | null;
}
/** 目标表是否仍具备需要回填的时间列。 */
export declare function hasTimestampColumns(db: PluginDatabase, table: string): Promise<boolean>;
/**
 * 回填时间。
 *
 * 只更新本任务刚创建的记录（用 ID 列表限定），并且带 `site_id` 条件，避免误伤。
 */
export declare function backfillTimestamps(db: PluginDatabase, table: string, siteId: string, entries: TimestampEntry[]): Promise<number>;
/** Unix 秒 → MySQL DATETIME 字符串（按服务端本地时区，与官方插件的 NOW() 口径一致）。 */
export declare function toSqlDateTime(value: Date): string;
/** Unix 秒 → Date；非法值回退到当前时间。 */
export declare function fromUnixSeconds(seconds: number): Date;
//# sourceMappingURL=timestamps.d.ts.map
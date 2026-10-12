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
const REQUIRED_COLUMNS = ['created_at', 'updated_at', 'published_at'];
/** 目标表是否仍具备需要回填的时间列。 */
export async function hasTimestampColumns(db, table) {
    const rows = await db.query(`SELECT COUNT(*) AS total FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?, ?)`, [table, ...REQUIRED_COLUMNS]);
    return Number(rows[0]?.total ?? 0) === REQUIRED_COLUMNS.length;
}
/**
 * 回填时间。
 *
 * 只更新本任务刚创建的记录（用 ID 列表限定），并且带 `site_id` 条件，避免误伤。
 */
export async function backfillTimestamps(db, table, siteId, entries) {
    if (entries.length === 0)
        return 0;
    let affected = 0;
    for (let index = 0; index < entries.length; index += 100) {
        const batch = entries.slice(index, index + 100);
        for (const entry of batch) {
            const outcome = await db.execute(`UPDATE ${table}
            SET created_at = ?, updated_at = ?, published_at = ?
          WHERE id = ? AND site_id = ?`, [
                toSqlDateTime(entry.createdAt),
                toSqlDateTime(entry.updatedAt),
                entry.publishedAt ? toSqlDateTime(entry.publishedAt) : null,
                entry.id,
                siteId
            ]);
            affected += outcome.affectedRows;
        }
    }
    return affected;
}
/** Unix 秒 → MySQL DATETIME 字符串（按服务端本地时区，与官方插件的 NOW() 口径一致）。 */
export function toSqlDateTime(value) {
    const pad = (input) => String(input).padStart(2, '0');
    return (`${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
        `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`);
}
/** Unix 秒 → Date；非法值回退到当前时间。 */
export function fromUnixSeconds(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0)
        return new Date();
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? new Date() : date;
}
//# sourceMappingURL=timestamps.js.map
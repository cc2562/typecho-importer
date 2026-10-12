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
import type { ParsedBackup } from './types.js';
/** 备份结构异常（不是合法 Typecho 备份 / 记录错位）。 */
export declare class BackupFormatError extends Error {
}
export declare function parseBackup(buffer: Buffer, fileName: string): ParsedBackup;
//# sourceMappingURL=parser.d.ts.map
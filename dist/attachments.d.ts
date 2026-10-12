/**
 * 附件导入（可选）。
 *
 * 备份里只有附件的路径（如 `/usr/uploads/2025/09/3003830580.avif`），没有文件本身，
 * 因此只有在插件设置里填了「源站根地址」时才尝试下载并存入媒体库。
 * 下载失败只记日志与失败明细，不影响文章导入主流程。
 */
import type { MediaService } from '@ricenote/shared';
import type { ImportFailure, TypechoAttachment } from './types.js';
export interface AttachmentSettings {
    originBaseUrl: string;
    downloadTimeoutMs: number;
    maxAttachmentBytes: number;
}
export interface ImportedMedia {
    mediaId: number;
    url: string;
}
export interface AttachmentImportResult {
    /** 附件路径 → 媒体库条目（用于设置封面）。 */
    mediaByPath: Map<string, ImportedMedia>;
    /** 正文里的旧链接 → 媒体库地址。 */
    replacements: Array<{
        from: string;
        to: string;
    }>;
    failures: ImportFailure[];
    downloaded: number;
    skipped: number;
}
export interface AttachmentContext {
    media?: MediaService;
    settings: AttachmentSettings;
    uploaderId?: number;
    log: (message: string, meta?: Record<string, unknown>) => void;
}
export declare function importAttachments(ctx: AttachmentContext, attachments: TypechoAttachment[], shouldStop: () => boolean): Promise<AttachmentImportResult>;
//# sourceMappingURL=attachments.d.ts.map
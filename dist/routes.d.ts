/**
 * 管理 API（Core 挂载前缀 `/api/admin`，因此实际路径是 `/api/admin/typecho/*`）。
 *
 * 响应统一 `{ data: ... }`；业务错误抛 `RiceNoteError`，由 Core 的错误处理转成对应的状态码。
 */
import type { PluginContext } from '@ricenote/plugin-sdk';
import type { ImporterRepository } from './repository.js';
import type { JobProgress } from './types.js';
import type { AttachmentSettings } from './attachments.js';
export interface Runner {
    jobId: number;
    canceled: boolean;
    progress: JobProgress;
}
export interface RouteDeps {
    ctx: PluginContext;
    siteId: string;
    repository: ImporterRepository;
    runners: Map<number, Runner>;
    excerptLength: number;
    attachmentSettings: AttachmentSettings;
    importCommentsByDefault: boolean;
}
export declare function registerRoutes(deps: RouteDeps): void;
//# sourceMappingURL=routes.d.ts.map
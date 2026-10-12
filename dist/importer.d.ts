/**
 * 导入流水线编排。
 *
 * 顺序：分类标签 → 附件（可选，先做才能设置封面）→ 文章 → 页面 → 时间回填 → 评论 → 自定义字段。
 *
 * 落库以服务契约为唯一入口（渲染、消毒、别名唯一化、词条关联、缓存失效都由原插件负责），
 * 只有「时间回填」与「评论」两处因为契约缺失而直写对方的表，且两处都先做列校验。
 */
import { type ContentPagesService, type ContentPostsService, type MediaService, type TaxonomyService } from '@ricenote/shared';
import type { PluginDatabase, PluginLogger } from '@ricenote/plugin-sdk';
import { type AttachmentSettings } from './attachments.js';
import { type ImporterRepository } from './repository.js';
import type { ImportOptions, JobProgress, ParsedBackup } from './types.js';
/** 任务被主动取消。 */
export declare class ImportCanceledError extends Error {
    constructor();
}
export interface ImportRuntime {
    db: PluginDatabase;
    logger: PluginLogger;
    siteId: string;
    repository: ImporterRepository;
    taxonomy?: TaxonomyService;
    posts?: ContentPostsService;
    pages?: ContentPagesService;
    media?: MediaService;
    excerptLength: number;
    attachmentSettings: AttachmentSettings;
}
export interface ImportRunInput {
    jobId: number;
    parsed: ParsedBackup;
    options: ImportOptions;
    onProgress: (progress: JobProgress) => Promise<void>;
    shouldStop: () => boolean;
}
export declare function runImport(runtime: ImportRuntime, input: ImportRunInput): Promise<JobProgress>;
//# sourceMappingURL=importer.d.ts.map
/**
 * 管理 API（Core 挂载前缀 `/api/admin`，因此实际路径是 `/api/admin/typecho/*`）。
 *
 * 响应统一 `{ data: ... }`；业务错误抛 `RiceNoteError`，由 Core 的错误处理转成对应的状态码。
 */
import { ErrorCode, RiceNoteError, SERVICE_CONTRACTS } from '@ricenote/shared';
import { parseBackup, BackupFormatError } from './parser.js';
import { runImport, ImportCanceledError } from './importer.js';
/** 上传备份的大小上限（传输层由 Core 统一限制，这里再收紧一次）。 */
const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
export function registerRoutes(deps) {
    const { ctx, repository, runners } = deps;
    /** 上传并解析备份，建立任务。 */
    ctx.routes.adminApi({
        method: 'POST',
        path: '/typecho/parse',
        permission: 'post.write',
        handler: async (request, reply) => {
            const file = (await request.file?.()) ?? undefined;
            if (!file) {
                throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, '未接收到上传文件', { status: 400 });
            }
            if (!/\.dat$/i.test(file.fileName)) {
                throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, '只支持 Typecho 导出的 .dat 备份文件', {
                    status: 400
                });
            }
            if (file.buffer.byteLength > MAX_BACKUP_BYTES) {
                throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, '备份文件超过 32MB 上限', { status: 400 });
            }
            let parsed;
            try {
                parsed = parseBackup(file.buffer, file.fileName);
            }
            catch (error) {
                if (error instanceof BackupFormatError) {
                    throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, error.message, { status: 400 });
                }
                throw error;
            }
            const options = {
                include: defaultInclude(deps),
                authorId: request.viewer?.user.id ?? 0,
                dryRun: false,
                excerptLength: deps.excerptLength,
                downloadAttachments: false
            };
            const jobId = await repository.createJob({
                siteId: deps.siteId,
                fileName: file.fileName,
                fileSize: file.buffer.byteLength,
                payload: file.buffer,
                stats: parsed.stats,
                options,
                warnings: parsed.warnings,
                operatorId: request.viewer?.user.id ?? null
            });
            ctx.logger.info('Typecho 备份解析完成', {
                jobId,
                posts: parsed.stats.posts,
                pages: parsed.stats.pages,
                comments: parsed.stats.comments,
                terms: parsed.stats.categories + parsed.stats.tags
            });
            reply.statusCode = 201;
            reply.json({ data: { id: jobId, stats: parsed.stats, warnings: parsed.warnings, options } });
        }
    });
    /** 任务列表。 */
    ctx.routes.adminApi({
        method: 'GET',
        path: '/typecho/jobs',
        permission: 'post.view',
        handler: async (request, reply) => {
            const limit = Number(request.query.limit ?? 20);
            const jobs = await repository.listJobs(Number.isFinite(limit) ? limit : 20);
            reply.json({ data: jobs });
        }
    });
    /** 任务详情（含进度与失败明细，前端轮询这个接口）。 */
    ctx.routes.adminApi({
        method: 'GET',
        path: '/typecho/jobs/:jobId',
        permission: 'post.view',
        handler: async (request, reply) => {
            const job = await requireJob(repository, request.params.jobId);
            reply.json({ data: job });
        }
    });
    /** 插件设置回显（前端据此提示"未配置源站地址将跳过附件"）。 */
    ctx.routes.adminApi({
        method: 'GET',
        path: '/typecho/settings',
        permission: 'post.view',
        handler: (_request, reply) => {
            reply.json({
                data: {
                    excerptLength: deps.excerptLength,
                    originBaseUrl: deps.attachmentSettings.originBaseUrl,
                    downloadTimeoutMs: deps.attachmentSettings.downloadTimeoutMs,
                    maxAttachmentBytes: deps.attachmentSettings.maxAttachmentBytes,
                    importComments: deps.importCommentsByDefault
                }
            });
        }
    });
    /** 执行导入（立即返回，任务在后台推进）。 */
    ctx.routes.adminApi({
        method: 'POST',
        path: '/typecho/jobs/:jobId/run',
        permission: 'post.write',
        handler: async (request, reply) => {
            const job = await requireJob(repository, request.params.jobId);
            if (job.status === 'running') {
                throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, '该任务正在执行中', { status: 409 });
            }
            const body = (request.body ?? {});
            const options = {
                include: {
                    ...job.options.include,
                    ...(body.include ?? {})
                },
                authorId: Number(body.authorId ?? job.options.authorId ?? request.viewer?.user.id ?? 0),
                dryRun: body.dryRun === true,
                excerptLength: Number(body.excerptLength ?? job.options.excerptLength ?? deps.excerptLength),
                downloadAttachments: body.downloadAttachments === true
            };
            if (!Number.isFinite(options.authorId) || options.authorId <= 0) {
                throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, '缺少内容归属作者', { status: 400 });
            }
            const runner = { jobId: job.id, canceled: false, progress: job.progress };
            runners.set(job.id, runner);
            await repository.updateStatus(job.id, 'running', { options, error: null });
            void executeJob(deps, job.id, options, runner).catch((error) => {
                ctx.logger.error('Typecho 导入任务异常', {
                    jobId: job.id,
                    reason: error instanceof Error ? error.message : String(error)
                });
            });
            reply.json({ data: { started: true, id: job.id } });
        }
    });
    /** 取消执行中的任务。 */
    ctx.routes.adminApi({
        method: 'POST',
        path: '/typecho/jobs/:jobId/cancel',
        permission: 'post.write',
        handler: async (request, reply) => {
            const job = await requireJob(repository, request.params.jobId);
            const runner = runners.get(job.id);
            if (runner)
                runner.canceled = true;
            await repository.updateStatus(job.id, 'canceled');
            reply.json({ data: { canceled: true, id: job.id } });
        }
    });
    /** 撤销本次导入：按映射删除本次生成的内容。 */
    ctx.routes.adminApi({
        method: 'POST',
        path: '/typecho/jobs/:jobId/rollback',
        permission: 'post.write',
        handler: async (request, reply) => {
            const job = await requireJob(repository, request.params.jobId);
            if (job.status === 'running') {
                throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, '任务执行中，请先取消', { status: 409 });
            }
            const result = await rollbackJob(deps, job.id);
            await repository.updateStatus(job.id, 'rolled_back');
            reply.json({ data: { id: job.id, removed: result.removed, failures: result.failures } });
        }
    });
}
/* --------------------------------- 执行 --------------------------------- */
async function executeJob(deps, jobId, options, runner) {
    const { ctx, repository } = deps;
    try {
        const payload = await repository.getPayload(jobId);
        if (!payload)
            throw new Error('任务缺少备份内容，请重新上传');
        const parsed = parseBackup(payload, `job-${jobId}.dat`);
        const runtime = {
            db: ctx.db,
            logger: ctx.logger,
            siteId: deps.siteId,
            repository,
            ...(ctx.services.tryUse(SERVICE_CONTRACTS.CONTENT_TAXONOMY)
                ? { taxonomy: ctx.services.use(SERVICE_CONTRACTS.CONTENT_TAXONOMY) }
                : {}),
            ...(ctx.services.tryUse(SERVICE_CONTRACTS.CONTENT_POSTS)
                ? { posts: ctx.services.use(SERVICE_CONTRACTS.CONTENT_POSTS) }
                : {}),
            ...(ctx.services.tryUse(SERVICE_CONTRACTS.CONTENT_PAGES)
                ? { pages: ctx.services.use(SERVICE_CONTRACTS.CONTENT_PAGES) }
                : {}),
            ...(ctx.services.tryUse(SERVICE_CONTRACTS.MEDIA_LIBRARY)
                ? { media: ctx.services.use(SERVICE_CONTRACTS.MEDIA_LIBRARY) }
                : {}),
            excerptLength: deps.excerptLength,
            attachmentSettings: deps.attachmentSettings
        };
        const progress = await runImport(runtime, {
            jobId,
            parsed,
            options,
            onProgress: async (next) => {
                runner.progress = next;
                await repository.updateProgress(jobId, next);
            },
            shouldStop: () => runner.canceled
        });
        await repository.updateStatus(jobId, 'done');
        ctx.logger.info('Typecho 导入完成', { jobId, counters: progress.counters, dryRun: options.dryRun });
    }
    catch (error) {
        if (error instanceof ImportCanceledError) {
            await repository.updateStatus(jobId, 'canceled');
            return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        await repository.updateStatus(jobId, 'failed', { error: reason });
    }
    finally {
        deps.runners.delete(jobId);
    }
}
/* --------------------------------- 撤销 --------------------------------- */
/**
 * 按映射删除本次任务生成的内容。
 *
 * 删除走各自插件的服务契约（评论没有单条删除接口，用批量审核的 delete 动作），
 * 失败项列出来交给人工处理，不会因为一条失败而中断其余清理。
 */
async function rollbackJob(deps, jobId) {
    const { ctx, repository } = deps;
    const rows = await repository.loadMapRows(jobId);
    const failures = [];
    let removed = 0;
    const posts = ctx.services.tryUse(SERVICE_CONTRACTS.CONTENT_POSTS);
    const pages = ctx.services.tryUse(SERVICE_CONTRACTS.CONTENT_PAGES);
    const media = ctx.services.tryUse(SERVICE_CONTRACTS.MEDIA_LIBRARY);
    const taxonomy = ctx.services.tryUse(SERVICE_CONTRACTS.CONTENT_TAXONOMY);
    const comments = ctx.services.tryUse(SERVICE_CONTRACTS.CONTENT_COMMENTS);
    const commentIds = rows
        .filter((row) => row.sourceType === 'comment' && row.targetId !== null)
        .map((row) => Number(row.targetId));
    if (commentIds.length > 0 && comments) {
        try {
            const outcome = await comments.moderate({ ids: commentIds, action: 'delete' });
            removed += outcome.affected;
        }
        catch (error) {
            failures.push({ sourceType: 'comment', sourceId: 0, reason: reasonOf(error) });
        }
    }
    for (const row of rows) {
        if (row.targetId === null)
            continue;
        const targetId = Number(row.targetId);
        try {
            switch (row.sourceType) {
                case 'post':
                    if (posts)
                        await posts.remove(targetId);
                    break;
                case 'page':
                    if (pages)
                        await pages.remove(targetId);
                    break;
                case 'attachment':
                    if (media)
                        await media.remove(targetId);
                    break;
                case 'meta':
                    if (taxonomy)
                        await taxonomy.remove(targetId);
                    break;
                default:
                    continue;
            }
            removed += 1;
        }
        catch (error) {
            failures.push({
                sourceType: row.sourceType,
                sourceId: Number(row.sourceId),
                ...(row.label ? { title: row.label } : {}),
                reason: reasonOf(error)
            });
        }
    }
    await repository.deleteFields(jobId);
    await repository.deleteMaps(jobId);
    ctx.logger.info('Typecho 导入已撤销', { jobId, removed, failed: failures.length });
    return { removed, failures };
}
/* --------------------------------- 工具 --------------------------------- */
async function requireJob(repository, rawId) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new RiceNoteError(ErrorCode.VALIDATION_FAILED, '任务 ID 非法', { status: 400 });
    }
    const job = await repository.getJob(id);
    if (!job) {
        throw new RiceNoteError(ErrorCode.NOT_FOUND, `任务不存在：${id}`, { status: 404 });
    }
    return job;
}
function defaultInclude(deps) {
    return {
        terms: true,
        posts: true,
        pages: true,
        comments: deps.importCommentsByDefault,
        attachments: false,
        fields: true
    };
}
function reasonOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=routes.js.map
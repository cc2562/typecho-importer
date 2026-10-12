/**
 * Typecho 导入插件入口。
 *
 * 注册后台管理 API 与「Typecho 导入」后台页面（页面在 manifest 里声明），
 * 启动/停止时维护后台任务的生命周期：内核重启后把残留的 running 任务标记为失败，
 * 插件停用时中断仍在执行的任务。
 */
import { definePlugin } from '@ricenote/plugin-sdk';
import { SERVICE_CONTRACTS } from '@ricenote/shared';
import { createRepository } from './repository.js';
import { registerRoutes } from './routes.js';
/** 插件实例状态：stop() 需要拿到同一份 runner 表来中断任务。 */
let active;
export default definePlugin({
    async start(ctx) {
        const setup = ctx.services.use(SERVICE_CONTRACTS.CORE_SETUP);
        const siteId = setup.siteId();
        const repository = createRepository(ctx.db);
        const runners = new Map();
        active = { runners };
        registerRoutes({
            ctx,
            siteId,
            repository,
            runners,
            excerptLength: readNumber(ctx, 'excerptLength', 120),
            attachmentSettings: {
                originBaseUrl: String(ctx.config.get('originBaseUrl', '') ?? '').trim(),
                downloadTimeoutMs: readNumber(ctx, 'downloadTimeoutMs', 15000),
                maxAttachmentBytes: readNumber(ctx, 'maxAttachmentBytes', 8 * 1024 * 1024)
            },
            importCommentsByDefault: ctx.config.get('importComments', true) !== false
        });
        // 上次进程退出时可能留下 running 状态的任务，这里统一收敛为失败，避免前端一直轮询。
        const jobs = await repository.listJobs(50);
        for (const job of jobs) {
            if (job.status === 'running') {
                await repository.updateStatus(job.id, 'failed', { error: '服务重启导致任务中断' });
            }
        }
        ctx.logger.info('Typecho 导入插件已启动', { siteId });
    },
    async stop(ctx) {
        if (active) {
            for (const runner of active.runners.values()) {
                runner.canceled = true;
            }
            active = undefined;
        }
        ctx.logger.info('Typecho 导入插件已停止');
    }
});
function readNumber(ctx, key, fallback) {
    const value = Number(ctx.config.get(key, fallback));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
//# sourceMappingURL=index.js.map
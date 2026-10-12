/**
 * Typecho 导入插件入口。
 *
 * 注册后台管理 API 与「Typecho 导入」后台页面（页面在 manifest 里声明），
 * 启动/停止时维护后台任务的生命周期：内核重启后把残留的 running 任务标记为失败，
 * 插件停用时中断仍在执行的任务。
 */
declare const _default: import("@ricenote/plugin-sdk").Plugin;
export default _default;
//# sourceMappingURL=index.d.ts.map
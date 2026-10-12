/**
 * 轻量 HTML → Markdown 转换器。
 *
 * 为什么自己写：备份里大量正文是从 WordPress / Typecho 编辑器带过来的 HTML，
 * 而本插件要以 git 方式分发（安装器不执行依赖安装），运行时依赖必须为零，
 * 仓库里也只有 md→html 方向的 `marked`，没有反向实现。
 *
 * 覆盖范围以真实备份为准：标题、段落、引用、有序/无序列表（含嵌套）、
 * 代码块、图片、链接、强调、删除线、分隔线、换行、表格、figure。
 * 未识别的标签退化为"取文本内容"，宁可少一点格式，也不要丢内容。
 */
/**
 * 把 HTML 转成 Markdown。
 *
 * 不抛异常：解析失败时逐段降级，保证导入流程不会被一段畸形 HTML 打断。
 */
export declare function htmlToMarkdown(html: string): string;
//# sourceMappingURL=html-to-markdown.d.ts.map
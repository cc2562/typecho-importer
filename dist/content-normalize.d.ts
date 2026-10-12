/**
 * 正文归一：判断 Typecho 正文是 Markdown 还是 HTML、转成 Markdown、生成摘要与替换链接。
 *
 * Typecho 的约定：正文以 `<!--markdown-->` 开头表示内容是 Markdown，
 * 其余（含从 WordPress 迁移过来的 `<!-- wp:xxx -->` 块）都是 HTML。
 */
/** Typecho 标记"本文为 Markdown"的注释。 */
export declare const MARKDOWN_MARKER = "<!--markdown-->";
export type ContentFormat = 'markdown' | 'html';
export interface NormalizedContent {
    format: ContentFormat;
    /** 可直接交给 posts / pages 保存的 Markdown 原文。 */
    markdown: string;
}
/** 正文是否为 Markdown（以标记为准，忽略前后空白）。 */
export declare function hasMarkdownMarker(text: string): boolean;
/**
 * 归一正文：Markdown 原文去掉标记后直接返回，HTML 则转换后再返回。
 *
 * 转换失败（异常）时退化为"去掉标签的纯文本"，宁可丢格式也不丢内容。
 */
export declare function normalizeContent(raw: string): NormalizedContent;
/**
 * 生成摘要。
 *
 * Typecho 没有 excerpt 字段，因此从正文去掉 Markdown 语法后截取；
 * `rn_posts.excerpt` 是 VARCHAR(500)，这里额外兜底截断。
 */
export declare function buildExcerpt(markdown: string, length: number): string;
/** 把 Markdown 压成连续纯文本（用于摘要与列表预览）。 */
export declare function toPlainText(markdown: string): string;
/**
 * 替换正文里的链接（导入附件后用媒体库地址换掉源站地址）。
 *
 * 同时处理 Markdown 图片/链接语法与残留的裸 URL。
 */
export declare function replaceLinks(markdown: string, replacements: Array<{
    from: string;
    to: string;
}>): string;
/**
 * 还原 Typecho 的 slug。
 *
 * 备份里既有 `sample-page` 也有 `%e5%88%92%e6%b0%b4` 这类 URL 编码值，
 * 还有中文原样保存的情况；解码失败时保留原值交由服务端做唯一化处理。
 */
export declare function decodeSlug(slug: string | null | undefined, fallback: string): string;
//# sourceMappingURL=content-normalize.d.ts.map
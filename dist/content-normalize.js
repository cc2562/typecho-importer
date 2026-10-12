/**
 * 正文归一：判断 Typecho 正文是 Markdown 还是 HTML、转成 Markdown、生成摘要与替换链接。
 *
 * Typecho 的约定：正文以 `<!--markdown-->` 开头表示内容是 Markdown，
 * 其余（含从 WordPress 迁移过来的 `<!-- wp:xxx -->` 块）都是 HTML。
 */
import { htmlToMarkdown } from './html-to-markdown.js';
/** Typecho 标记"本文为 Markdown"的注释。 */
export const MARKDOWN_MARKER = '<!--markdown-->';
/** 正文是否为 Markdown（以标记为准，忽略前后空白）。 */
export function hasMarkdownMarker(text) {
    return text.trimStart().startsWith(MARKDOWN_MARKER);
}
/**
 * 归一正文：Markdown 原文去掉标记后直接返回，HTML 则转换后再返回。
 *
 * 转换失败（异常）时退化为"去掉标签的纯文本"，宁可丢格式也不丢内容。
 */
export function normalizeContent(raw) {
    const source = raw ?? '';
    if (hasMarkdownMarker(source)) {
        return { format: 'markdown', markdown: stripMarkdownMarker(source) };
    }
    if (!looksLikeHtml(source)) {
        // 没有标记也没有标签：按纯文本处理（Typecho 早期版本常见）。
        return { format: 'markdown', markdown: source.trim() };
    }
    try {
        return { format: 'html', markdown: htmlToMarkdown(source) };
    }
    catch {
        return { format: 'html', markdown: stripTags(source) };
    }
}
function stripMarkdownMarker(source) {
    return source.replace(MARKDOWN_MARKER, '').trim();
}
/** 是否包含 HTML 标签或实体（用于区分"纯文本"与"HTML"）。 */
function looksLikeHtml(source) {
    return /<\/?[a-zA-Z][^>]*>/.test(source) || /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/.test(source);
}
/** 兜底：去掉标签与注释，只留文本。 */
function stripTags(source) {
    return source
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/**
 * 生成摘要。
 *
 * Typecho 没有 excerpt 字段，因此从正文去掉 Markdown 语法后截取；
 * `rn_posts.excerpt` 是 VARCHAR(500)，这里额外兜底截断。
 */
export function buildExcerpt(markdown, length) {
    const plain = toPlainText(markdown);
    const limit = Math.max(20, Math.min(500, Math.floor(length)));
    if (plain.length <= limit)
        return plain;
    return `${plain.slice(0, limit).trimEnd()}…`;
}
/** 把 Markdown 压成连续纯文本（用于摘要与列表预览）。 */
export function toPlainText(markdown) {
    return markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')
        .replace(/^\s*(---+|\*\*\*+)\s*$/gm, ' ')
        .replace(/(\*\*|__|\*|_|~~)/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * 替换正文里的链接（导入附件后用媒体库地址换掉源站地址）。
 *
 * 同时处理 Markdown 图片/链接语法与残留的裸 URL。
 */
export function replaceLinks(markdown, replacements) {
    let output = markdown;
    for (const { from, to } of replacements) {
        if (from.length === 0 || from === to)
            continue;
        output = output.split(from).join(to);
    }
    return output;
}
/**
 * 还原 Typecho 的 slug。
 *
 * 备份里既有 `sample-page` 也有 `%e5%88%92%e6%b0%b4` 这类 URL 编码值，
 * 还有中文原样保存的情况；解码失败时保留原值交由服务端做唯一化处理。
 */
export function decodeSlug(slug, fallback) {
    const raw = (slug ?? '').trim();
    if (raw.length === 0)
        return fallback;
    if (!raw.includes('%'))
        return raw;
    try {
        const decoded = decodeURIComponent(raw).trim();
        return decoded.length > 0 ? decoded : fallback;
    }
    catch {
        return raw;
    }
}
//# sourceMappingURL=content-normalize.js.map
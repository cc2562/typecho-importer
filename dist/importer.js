/**
 * 导入流水线编排。
 *
 * 顺序：分类标签 → 附件（可选，先做才能设置封面）→ 文章 → 页面 → 时间回填 → 评论 → 自定义字段。
 *
 * 落库以服务契约为唯一入口（渲染、消毒、别名唯一化、词条关联、缓存失效都由原插件负责），
 * 只有「时间回填」与「评论」两处因为契约缺失而直写对方的表，且两处都先做列校验。
 */
import { normalizeSlug } from '@ricenote/shared';
import { importAttachments } from './attachments.js';
import { commentStatusOf, hasCommentColumns, insertComments } from './comments.js';
import { backfillTimestamps, fromUnixSeconds, hasTimestampColumns } from './timestamps.js';
import { buildExcerpt, decodeSlug, normalizeContent, replaceLinks } from './content-normalize.js';
import { defaultProgress } from './repository.js';
/** 任务被主动取消。 */
export class ImportCanceledError extends Error {
    constructor() {
        super('导入已被取消');
    }
}
const PROGRESS_FLUSH_EVERY = 20;
const COVER_FIELD_NAMES = ['imgurl', 'featuredimage', 'thumbnail', 'cover'];
export async function runImport(runtime, input) {
    const { parsed, options } = input;
    const progress = defaultProgress();
    const dryRun = options.dryRun;
    const includedTerms = options.include.terms ? parsed.metas : [];
    const postContents = options.include.posts
        ? parsed.contents.filter((item) => item.type !== 'page' && item.type !== 'page_draft')
        : [];
    const pageContents = options.include.pages
        ? parsed.contents.filter((item) => item.type === 'page' || item.type === 'page_draft')
        : [];
    const attachments = options.include.attachments ? parsed.attachments : [];
    progress.total =
        includedTerms.length +
            postContents.length +
            pageContents.length +
            (options.include.comments ? parsed.comments.length : 0) +
            attachments.length +
            (options.include.fields ? parsed.fields.length : 0);
    let flushCounter = 0;
    const bump = async (count = 1) => {
        progress.processed += count;
        flushCounter += count;
        if (flushCounter >= PROGRESS_FLUSH_EVERY) {
            flushCounter = 0;
            await input.onProgress(progress);
        }
    };
    const stopIfAsked = () => {
        if (input.shouldStop())
            throw new ImportCanceledError();
    };
    /* ------------------------------ 1. 分类与标签 ------------------------------ */
    progress.phase = 'terms';
    await input.onProgress(progress);
    const termMap = new Map();
    const existingTerms = await runtime.repository.loadMaps(input.jobId, 'meta');
    const termEntries = [];
    for (const meta of includedTerms) {
        stopIfAsked();
        if (existingTerms.has(meta.mid)) {
            termMap.set(meta.mid, existingTerms.get(meta.mid));
            progress.counters.skipped += 1;
            await bump();
            continue;
        }
        if (dryRun || !runtime.taxonomy) {
            progress.counters.terms += 1;
            await bump();
            continue;
        }
        try {
            const saved = await runtime.taxonomy.save({
                name: meta.name,
                slug: normalizeSlug(decodeSlug(meta.slug, `mid-${meta.mid}`), `mid-${meta.mid}`),
                type: termTypeOf(meta),
                ...(meta.description ? { description: meta.description } : {})
            });
            termMap.set(meta.mid, saved.id);
            termEntries.push({ sourceType: 'meta', sourceId: meta.mid, targetId: saved.id, label: meta.name });
            progress.counters.terms += 1;
        }
        catch (error) {
            progress.failures.push(failure('meta', meta.mid, meta.name, error));
        }
        await bump();
    }
    if (termEntries.length > 0 && !dryRun) {
        await runtime.repository.saveMaps(runtime.siteId, input.jobId, termEntries);
    }
    /* -------------------------------- 2. 附件 -------------------------------- */
    progress.phase = 'attachments';
    await input.onProgress(progress);
    let mediaByPath = new Map();
    let replacements = [];
    if (attachments.length > 0 && options.downloadAttachments && !dryRun) {
        const result = await importAttachments({
            ...(runtime.media ? { media: runtime.media } : {}),
            settings: runtime.attachmentSettings,
            ...(options.authorId ? { uploaderId: options.authorId } : {}),
            log: (message, meta) => runtime.logger.warn(message, meta)
        }, attachments, input.shouldStop);
        mediaByPath = result.mediaByPath;
        replacements = result.replacements;
        progress.counters.attachments = result.downloaded;
        progress.counters.skipped += result.skipped;
        progress.failures.push(...result.failures);
        const entries = attachments
            .filter((item) => item.path && mediaByPath.has(item.path))
            .map((item) => ({
            sourceType: 'attachment',
            sourceId: item.cid,
            targetId: mediaByPath.get(item.path)?.mediaId ?? null,
            label: item.title
        }));
        if (entries.length > 0) {
            await runtime.repository.saveMaps(runtime.siteId, input.jobId, entries);
        }
        progress.processed += attachments.length;
    }
    else {
        progress.processed += attachments.length;
    }
    await input.onProgress(progress);
    const fieldsByCid = groupFields(parsed.fields);
    const relationsByCid = groupRelations(parsed.relationships);
    /* -------------------------------- 3. 文章 -------------------------------- */
    progress.phase = 'posts';
    await input.onProgress(progress);
    const postEntries = [];
    const postTimestamps = [];
    const existingPosts = await runtime.repository.loadMaps(input.jobId, 'post');
    const postIdByCid = new Map(existingPosts);
    for (const content of postContents) {
        stopIfAsked();
        if (postIdByCid.has(content.cid)) {
            progress.counters.skipped += 1;
            await bump();
            continue;
        }
        const normalized = normalizeContent(content.text);
        const markdown = replacements.length > 0 ? replaceLinks(normalized.markdown, replacements) : normalized.markdown;
        const status = postStatusOf(content);
        if (dryRun || !runtime.posts) {
            progress.counters.posts += 1;
            await bump();
            continue;
        }
        try {
            const saved = await runtime.posts.save({
                authorId: options.authorId,
                payload: {
                    title: content.title || `未命名-${content.cid}`,
                    slug: normalizeSlug(decodeSlug(content.slug, `cid-${content.cid}`), `cid-${content.cid}`),
                    content: markdown,
                    excerpt: buildExcerpt(markdown, options.excerptLength || runtime.excerptLength),
                    status,
                    termIds: termIdsOf(relationsByCid.get(content.cid) ?? [], termMap),
                    ...(coverOf(fieldsByCid.get(content.cid) ?? [], mediaByPath) ?? {})
                }
            });
            postIdByCid.set(content.cid, saved.id);
            postEntries.push({
                sourceType: 'post',
                sourceId: content.cid,
                targetId: saved.id,
                label: content.title
            });
            postTimestamps.push({
                id: saved.id,
                createdAt: fromUnixSeconds(content.created),
                updatedAt: fromUnixSeconds(content.modified),
                publishedAt: status === 'published' ? fromUnixSeconds(content.created) : null
            });
            progress.counters.posts += 1;
        }
        catch (error) {
            progress.failures.push(failure('post', content.cid, content.title, error));
        }
        await bump();
    }
    if (postEntries.length > 0 && !dryRun) {
        await runtime.repository.saveMaps(runtime.siteId, input.jobId, postEntries);
    }
    /* -------------------------------- 4. 页面 -------------------------------- */
    progress.phase = 'pages';
    await input.onProgress(progress);
    const pageEntries = [];
    const pageTimestamps = [];
    const existingPages = await runtime.repository.loadMaps(input.jobId, 'page');
    for (const content of pageContents) {
        stopIfAsked();
        if (existingPages.has(content.cid)) {
            progress.counters.skipped += 1;
            await bump();
            continue;
        }
        const normalized = normalizeContent(content.text);
        const markdown = replacements.length > 0 ? replaceLinks(normalized.markdown, replacements) : normalized.markdown;
        const status = content.status === 'publish' && !content.type.endsWith('_draft') ? 'published' : 'draft';
        if (dryRun || !runtime.pages) {
            progress.counters.pages += 1;
            await bump();
            continue;
        }
        try {
            const saved = await runtime.pages.save({
                authorId: options.authorId,
                payload: {
                    title: content.title || `未命名-${content.cid}`,
                    slug: normalizeSlug(decodeSlug(content.slug, `cid-${content.cid}`), `cid-${content.cid}`),
                    content: markdown,
                    status,
                    sortOrder: content.order || 0
                }
            });
            pageEntries.push({ sourceType: 'page', sourceId: content.cid, targetId: saved.id, label: content.title });
            pageTimestamps.push({
                id: saved.id,
                createdAt: fromUnixSeconds(content.created),
                updatedAt: fromUnixSeconds(content.modified),
                publishedAt: status === 'published' ? fromUnixSeconds(content.created) : null
            });
            progress.counters.pages += 1;
        }
        catch (error) {
            progress.failures.push(failure('page', content.cid, content.title, error));
        }
        await bump();
    }
    if (pageEntries.length > 0 && !dryRun) {
        await runtime.repository.saveMaps(runtime.siteId, input.jobId, pageEntries);
    }
    /* ------------------------------ 5. 时间线回填 ------------------------------ */
    progress.phase = 'timestamps';
    await input.onProgress(progress);
    if (!dryRun) {
        if (postTimestamps.length > 0 && (await hasTimestampColumns(runtime.db, 'rn_posts'))) {
            await backfillTimestamps(runtime.db, 'rn_posts', runtime.siteId, postTimestamps);
        }
        else if (postTimestamps.length > 0) {
            runtime.logger.warn('rn_posts 缺少时间列，跳过发布时间回填', { count: postTimestamps.length });
        }
        if (pageTimestamps.length > 0 && (await hasTimestampColumns(runtime.db, 'rn_pages'))) {
            await backfillTimestamps(runtime.db, 'rn_pages', runtime.siteId, pageTimestamps);
        }
        else if (pageTimestamps.length > 0) {
            runtime.logger.warn('rn_pages 缺少时间列，跳过页面时间回填', { count: pageTimestamps.length });
        }
    }
    /* -------------------------------- 6. 评论 -------------------------------- */
    progress.phase = 'comments';
    await input.onProgress(progress);
    if (options.include.comments && !dryRun) {
        const commentsTable = 'rn_comments';
        const existingComments = await runtime.repository.loadMaps(input.jobId, 'comment');
        const items = parsed.comments
            .filter((comment) => !existingComments.has(comment.coid))
            .map((comment) => ({
            coid: comment.coid,
            postId: postIdByCid.get(comment.cid) ?? 0,
            parentCoid: comment.parent,
            authorName: comment.author || '匿名访客',
            authorEmail: comment.mail || '',
            authorUrl: comment.url,
            content: comment.text,
            status: commentStatusOf(comment),
            ip: comment.ip,
            agent: comment.agent,
            createdAt: fromUnixSeconds(comment.created)
        }))
            .filter((item) => item.postId > 0);
        progress.counters.skipped += parsed.comments.length - items.length;
        if (items.length > 0 && (await hasCommentColumnsSafe(runtime))) {
            const mapping = await insertComments(runtime.db, commentsTable, runtime.siteId, items);
            progress.counters.comments = mapping.size;
            const entries = [...mapping.entries()].map(([coid, id]) => ({
                sourceType: 'comment',
                sourceId: coid,
                targetId: id
            }));
            if (entries.length > 0) {
                await runtime.repository.saveMaps(runtime.siteId, input.jobId, entries);
            }
        }
        progress.processed += parsed.comments.length;
    }
    else if (options.include.comments) {
        progress.processed += parsed.comments.length;
    }
    await input.onProgress(progress);
    /* ------------------------------ 7. 自定义字段 ------------------------------ */
    progress.phase = 'fields';
    await input.onProgress(progress);
    if (options.include.fields && !dryRun && parsed.fields.length > 0) {
        try {
            await runtime.repository.saveFields(runtime.siteId, input.jobId, parsed.fields);
            progress.counters.fields = parsed.fields.length;
        }
        catch (error) {
            progress.failures.push(failure('field', 0, '自定义字段', error));
        }
    }
    progress.processed += options.include.fields ? parsed.fields.length : 0;
    progress.phase = 'done';
    await input.onProgress(progress);
    return progress;
}
/* --------------------------------- 辅助函数 --------------------------------- */
function termTypeOf(meta) {
    return meta.type === 'tag' ? 'tag' : 'category';
}
function postStatusOf(content) {
    if (content.type.endsWith('_draft'))
        return 'draft';
    if (content.status === 'publish')
        return 'published';
    return 'draft';
}
function groupFields(fields) {
    const result = new Map();
    for (const field of fields) {
        const list = result.get(field.cid) ?? [];
        list.push(field);
        result.set(field.cid, list);
    }
    return result;
}
function groupRelations(relationships) {
    const result = new Map();
    for (const relation of relationships) {
        const list = result.get(relation.cid) ?? [];
        list.push(relation.mid);
        result.set(relation.cid, list);
    }
    return result;
}
function termIdsOf(mids, termMap) {
    const ids = mids.map((mid) => termMap.get(mid)).filter((id) => id !== undefined);
    return [...new Set(ids)];
}
/**
 * 从 Typecho 自定义字段里找封面。
 *
 * 字段值是源站的绝对 URL，按"包含附件路径"匹配已下载的媒体条目，
 * 没有匹配到就不设置封面（RiceNote 的 cover 必须是媒体库 ID）。
 */
function coverOf(fields, mediaByPath) {
    if (mediaByPath.size === 0)
        return undefined;
    for (const field of fields) {
        if (!COVER_FIELD_NAMES.includes(field.name.toLowerCase()))
            continue;
        const value = field.strValue.trim();
        if (value.length === 0)
            continue;
        for (const [path, media] of mediaByPath) {
            if (value.includes(path))
                return { coverMediaId: media.mediaId };
        }
    }
    return undefined;
}
async function hasCommentColumnsSafe(runtime) {
    const ok = await hasCommentColumns(runtime.db, 'rn_comments');
    if (!ok) {
        runtime.logger.warn('rn_comments 缺少导入所需的列，跳过评论导入');
    }
    return ok;
}
function failure(sourceType, sourceId, title, error) {
    return {
        sourceType,
        sourceId,
        ...(title ? { title } : {}),
        reason: error instanceof Error ? error.message : String(error)
    };
}
//# sourceMappingURL=importer.js.map
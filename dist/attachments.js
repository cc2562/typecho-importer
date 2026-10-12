/**
 * 附件导入（可选）。
 *
 * 备份里只有附件的路径（如 `/usr/uploads/2025/09/3003830580.avif`），没有文件本身，
 * 因此只有在插件设置里填了「源站根地址」时才尝试下载并存入媒体库。
 * 下载失败只记日志与失败明细，不影响文章导入主流程。
 */
export async function importAttachments(ctx, attachments, shouldStop) {
    const mediaByPath = new Map();
    const replacements = [];
    const failures = [];
    const base = ctx.settings.originBaseUrl.trim().replace(/\/+$/, '');
    const media = ctx.media;
    if (base.length === 0 || !media) {
        return {
            mediaByPath,
            replacements,
            failures,
            downloaded: 0,
            skipped: attachments.length
        };
    }
    let downloaded = 0;
    let skipped = 0;
    for (const attachment of attachments) {
        if (shouldStop())
            break;
        if (!attachment.path) {
            skipped += 1;
            failures.push({
                sourceType: 'attachment',
                sourceId: attachment.cid,
                title: attachment.title,
                reason: '无法解析附件路径（序列化格式异常）'
            });
            continue;
        }
        const url = `${base}${attachment.path.startsWith('/') ? '' : '/'}${attachment.path}`;
        try {
            const buffer = await download(url, ctx.settings);
            const fileName = attachment.name ?? attachment.path.split('/').pop() ?? `attachment-${attachment.cid}`;
            const mimeType = attachment.mime ?? guessMime(fileName);
            const summary = await media.save({
                fileName,
                mimeType,
                buffer,
                ...(attachment.title ? { alt: attachment.title } : {}),
                ...(ctx.uploaderId ? { uploaderId: ctx.uploaderId } : {})
            });
            const entry = { mediaId: summary.id, url: summary.url };
            mediaByPath.set(attachment.path, entry);
            replacements.push({ from: url, to: summary.url });
            // 正文里也可能写相对路径（主题里常见的 `/usr/uploads/...`）。
            replacements.push({ from: attachment.path, to: summary.url });
            downloaded += 1;
        }
        catch (error) {
            skipped += 1;
            failures.push({
                sourceType: 'attachment',
                sourceId: attachment.cid,
                title: attachment.title,
                reason: `下载失败：${describeError(error)}`
            });
            ctx.log('附件下载失败', { cid: attachment.cid, url, reason: describeError(error) });
        }
    }
    return { mediaByPath, replacements, failures, downloaded, skipped };
}
async function download(url, settings) {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(1000, settings.downloadTimeoutMs))
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > settings.maxAttachmentBytes) {
        throw new Error(`文件超过大小上限（${declaredLength} 字节）`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > settings.maxAttachmentBytes) {
        throw new Error(`文件超过大小上限（${buffer.byteLength} 字节）`);
    }
    if (buffer.byteLength === 0) {
        throw new Error('下载内容为空');
    }
    return buffer;
}
const MIME_BY_EXTENSION = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    pdf: 'application/pdf',
    zip: 'application/zip'
};
function guessMime(fileName) {
    const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
    return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}
function describeError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
//# sourceMappingURL=attachments.js.map
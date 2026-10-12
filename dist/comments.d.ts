/**
 * 评论导入：直接写入 `rn_comments`。
 *
 * 之所以直写：comments 插件只提供前台 `submit()`（作者、时间、状态都由插件自己决定）
 * 与后台审核接口，没有"按指定作者/时间/状态批量创建"的契约，迁移场景无法使用。
 *
 * 复现 comments 插件的两条规则，保证数据口径一致：
 * - `ip_hash` = `sha256(siteId|comment|ip)`（只用于反垃圾比对，不可还原）；
 * - 先插入全部评论拿到 `coid → id` 映射，再回填 `parent_id`（楼中楼回复要跨行引用）。
 */
import type { PluginDatabase } from '@ricenote/plugin-sdk';
import type { TypechoComment } from './types.js';
export type CommentStatus = 'pending' | 'approved' | 'spam' | 'trash';
export interface CommentImportItem {
    coid: number;
    postId: number;
    parentCoid: number;
    authorName: string;
    authorEmail: string;
    authorUrl: string | null;
    content: string;
    status: CommentStatus;
    ip: string | null;
    agent: string | null;
    createdAt: Date;
}
/** `rn_comments` 是否仍具备导入所需的列。 */
export declare function hasCommentColumns(db: PluginDatabase, table: string): Promise<boolean>;
/**
 * 插入评论并回填父子关系，返回 `coid → commentId`。
 *
 * 父评论不存在（例如父评论属于被跳过的页面）时降级为一级评论，不丢内容。
 */
export declare function insertComments(db: PluginDatabase, table: string, siteId: string, items: CommentImportItem[]): Promise<Map<number, number>>;
/**
 * Typecho 评论状态 → RiceNote 状态。
 *
 * 含 `[secret]` 的私密评论在 Typecho 里只有登录者可见，
 * 这里一律降为待审核，避免把私密内容直接公开。
 */
export declare function commentStatusOf(comment: TypechoComment): CommentStatus;
//# sourceMappingURL=comments.d.ts.map
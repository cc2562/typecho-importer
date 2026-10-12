# Typecho 导入（ccrice.typecho-importer）

把 Typecho 后台导出的 `.dat` 备份文件迁移到 RiceNote：上传备份 → 预览统计 → 勾选导入项 → 执行并查看进度与结果 → 可撤销本次导入。

## 安装

### 方式一：从 Git 仓库安装（推荐）

```bash
pnpm plugin install --git https://github.com/cc2562/typecho-importer --ref main
```

或在后台「扩展中心 → 安装插件 → Git 仓库」填写仓库地址与引用。

> 仓库根目录即插件目录（`manifest.json` 位于仓库根）。**构建产物 `dist/` 已随仓库提交**，
> 安装器会跳过依赖安装与构建（本包的 dev 依赖使用 `workspace:` 协议），克隆后可直接启用。
> 修改源码后请先在仓库内执行 `pnpm build` 再提交 `dist/`。

### 方式二：本地目录（开发调试）

把**父目录**登记到环境变量（扫描规则只认根目录下的子目录）：

```dotenv
RICENOTE_LOCAL_PLUGINS=./plugins-community
```

登记后不需要"安装"，开发环境改动文件会自动重启内核。

## 使用

1. 后台启用插件（首次出现默认未启用，启用会触发一次进程内重启）。
2. 进入侧栏「Typecho 导入」。
3. 上传 `.dat` 备份 → 查看解析概览（文章 / 页面 / 分类 / 标签 / 评论 / 附件 / 自定义字段数量）。
4. 勾选要导入的内容类型、选择归属作者，可先「试运行」再「开始导入」。
5. 完成后查看成功 / 跳过 / 失败明细；可在历史任务里「撤销本次导入」。

### 插件设置

| 设置项 | 说明 |
| --- | --- |
| `excerptLength` | 生成摘要的长度（Typecho 无摘要字段，默认 120 字） |
| `importComments` | 导入界面是否默认勾选评论 |
| `originBaseUrl` | 源站根地址，例如 `https://world.ccrice.com`；**留空则跳过附件**，正文保留原链接 |
| `downloadTimeoutMs` | 单个附件下载超时（默认 15000ms） |
| `maxAttachmentBytes` | 单个附件大小上限（默认 8MB） |

## 支持的数据

| Typecho | RiceNote |
| --- | --- |
| metas（category / tag） | 分类与标签（`content.taxonomy@1`） |
| contents.type = post / post_draft | 文章（`content.posts@1`） |
| contents.type = page | 独立页面（`content.pages@1`） |
| contents.type = attachment | 媒体库（`media.library@1`，需填写源站地址） |
| relationships | 文章 ↔ 分类标签关联 |
| comments | 评论（保留作者、邮箱、网址、时间、审核状态与楼中楼回复） |
| fields | 自定义字段，写入插件自有表备查；`imgurl` / `FeaturedImage` 用于设置封面 |
| users | 仅作参考，内容统一归属到界面选择的作者 |

正文处理规则：

- 含 `<!--markdown-->` 标记：剥离标记后按 Markdown 原文导入；
- 其余按 HTML 解析（会先剔除 `<!-- wp:xxx -->` 块注释），转换为 Markdown 后再导入；
- 转换后的 Markdown 交给 posts / pages 插件渲染，保证「后台预览 == 前台展示」。

状态映射：

- 文章：`publish → published`，`draft` / `hidden` / `post_draft → draft`；
- 评论：`approved → approved`，`spam → spam`，其余 `pending`；含 `[secret]` 的私密评论强制 `pending`。

## 实现说明与已知风险

- **备份格式**：`%TYPECHO_BACKUP_0001%` 头尾包裹，记录为
  `[1B 表序号][1B 0x00][2B LE 头长][4B LE 值长][JSON 头][值拼接][32B 校验串]`；
  解析器**顺序读取**，不用全文搜索定位（正文里的 WordPress 块属性 JSON 会造成大量误命中）。
- **时间线保真**：posts / pages 的保存契约不接受时间参数，因此文章与页面创建后由本插件
  直接 `UPDATE rn_posts / rn_pages` 的 `created_at / updated_at / published_at`；
  评论无批量导入契约，由本插件直接 `INSERT INTO rn_comments`（`ip_hash` 复现
  comments 插件的 `sha256(siteId|comment|ip)` 规则）。
  **这两处直写依赖官方插件的表结构：升级 posts / pages / comments 后若列名变更需同步本插件。**
  执行前会先用 `information_schema.COLUMNS` 校验列存在，缺列时降级为「不改时间 / 不导评论」并写入告警，不会中断任务。
- **幂等**：`rn_typecho_importer_maps` 记录 `Typecho ID → RiceNote ID`，重复执行自动跳过已导入项；撤销按同一份映射删除。
- 本插件不改动任何官方插件源码，也不新增运行时依赖（HTML→Markdown 与 PHP `serialize` 解析均为内置实现）。

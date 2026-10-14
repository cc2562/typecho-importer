# Typecho 导入（ccrice.typecho-importer）

| 项目 | 值 |
| --- | --- |
| 插件版本 | `1.1.0` |
| 适用宿主 | RiceNote **0.7.x**（`peerDependencies` 区间 `^0.7.0`） |
| Plugin API | `^1.0.0` |
| 分发方式 | Git 仓库 `https://github.com/cc2562/typecho-importer`（`dist/` 随仓库提交，克隆即可用） |

把 Typecho 后台导出的 `.dat` 备份文件迁移到 RiceNote：上传备份 → 预览统计 → 勾选导入项 → 执行并查看进度与结果 → 可撤销本次导入。

> **宿主区间为什么是 `^0.7.0`**：RiceNote 处在 `0.x` 阶段，官方约定是「插件的宿主区间跟随宿主的**次版本**」
> （`0.7.0` → `^0.7.0`，等价于 `>=0.7.0 <0.8.0`），补丁升级不动区间、次版本跃迁才需要跟着升。
> 14 个官方插件与之一致。

变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 安装

### 方式一：从 Git 仓库安装（推荐）

```bash
pnpm plugin install --git https://github.com/cc2562/typecho-importer --ref v1.1.0
```

或在后台「扩展中心 → 安装插件 → Git 仓库」填写仓库地址与引用（`--ref` 也接受分支或提交号）。

> 仓库根目录即插件目录（`manifest.json` 位于仓库根）。**构建产物 `dist/` 已随仓库提交**，
> 安装器会跳过依赖安装与构建（本包的 dev 依赖使用 `workspace:` 协议），克隆后可直接启用。
> 修改源码后请先在仓库内执行构建再提交 `dist/`。

### 方式二：本地目录（开发调试）

把**父目录**登记到环境变量（扫描规则只认根目录下的子目录）：

```dotenv
RICENOTE_LOCAL_PLUGINS=./plugins-community
```

再把这个父目录登记进 `pnpm-workspace.yaml` 的 `packages`，本插件才能用 `pnpm --filter` 构建：

```yaml
packages:
  - 'plugins-community/*'
```

```bash
pnpm install
pnpm --filter @ccrice/ricenote-plugin-typecho-importer typecheck
pnpm --filter @ccrice/ricenote-plugin-typecho-importer build   # 改动源码后必须重建并提交 dist/
```

登记后不需要"安装"动作，开发环境改动文件会自动重启内核。

> ⚠️ **两种方式不可同时存在**：插件 ID 是 `ccrice.typecho-importer`，
> 若 `plugins/third-party/` 下已有一份 git 安装副本，内核会判定后扫描到的那份「插件 ID 重复」并拒绝加载，
> 主仓库的 `pnpm validate` 也会因此变红（它会要求 `wiki/Plugins-Overview.md` 有该插件的版本行）。
> 想从「本地目录」切到「可更新安装」，请先撤掉 `RICENOTE_LOCAL_PLUGINS`（或移除本地目录）再执行安装命令。

## 升级

| 场景 | 做法 |
| --- | --- |
| 宿主次版本跃迁（如 `0.6.x → 0.7.0`） | 本插件已把区间升到 `^0.7.0`，旧宿主上会被判「宿主区间不符」——用下面的更新流程装新版，**不要手改区间** |
| 后台 | 「扩展中心」里点插件行内的「更新」 |
| CLI | `pnpm plugin updates` 查更新 → `pnpm plugin update ccrice.typecho-importer` |
| 指定版本 | `pnpm plugin install --git https://github.com/cc2562/typecho-importer --ref v1.1.0` |

- 升级会**按已记录的来源重新 clone 并 checkout**（git 来源不做增量 fetch），成功与否都不会留下半成品目录；
  失败自动回滚，按原样保留旧版本。
- 插件的启停与安装/更新**都需要重启进程**才生效。
- 插件卸载**不会删除数据表**（`rn_typecho_importer_*` 保留），重新启用后导入历史与映射仍在。
- 若升级的官方 `posts` / `pages` / `comments` 插件改动了 `rn_posts` / `rn_pages` / `rn_comments` 的列名，
  需同步本插件的直写逻辑（见文末「已知风险」）。

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
- 转换后的 Markdown 交给 posts / pages 插件渲染，保证「后台预览 == 前台展示」；
- 摘要在正文转成 Markdown 后按 `excerptLength` 生成，并复用内核的 `stripShortcodeMarks`
  剥离短代码标记（与 0.7.0 起内核在列表摘要、搜索摘要、SEO 描述、RSS 中的口径一致；
  **正文存储本身不做任何改写**）。

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
- **0.7.0 兼容性**：已逐项核对 manifest 字段、`PluginContext` 用到的 API、四个服务契约
  （`content.posts@1` / `content.pages@1` / `content.taxonomy@1` / `media.library@1`）、
  三张直写表的列，以及后台 SDK 的组件与图标 —— 无破坏性变更。
  本插件不注册前台页面路由，因此与 0.7.0 的路径接管能力（`ctx.routes.overridePath`、
  `rice.permalink` 固定链接、路径模板引擎）没有交集。

# Changelog

本插件的显著变更都记录在此文件中；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [1.1.0] - 2026-10-14

面向 RiceNote 0.7.0 的兼容升级（宿主区间 `^0.5.0` → `^0.7.0`）。

### Changed

- **宿主区间升到 `^0.7.0`**：0.7.0 是次版本跃迁，按仓库约定（插件的宿主区间跟随宿主**次版本**），
  插件同步改区间并升次版本。旧宿主（0.5.x / 0.6.x）会判为「宿主区间不符」，需用插件更新流程装新版。
  实际启动校验只看 `manifest.apiVersion`（`^1.0.0`），区间用于语义表达与更新检查。
- **摘要与内核口径对齐**：摘要生成复用内核的 `stripShortcodeMarks` 剥离短代码标记，
  与 0.7.0 起内核在列表摘要、搜索摘要、SEO 描述、RSS 中的处理一致；**正文存储不改写**。
  调用次序刻意放在代码块、行内代码与链接/图片处理**之后**，与内核 `markdownToPlainText` 相同。

### Fixed

- 后台任务列表的状态徽章兜底变体由 `secondary` 改为 `muted`：
  0.7.0 的 `Badge` 合法变体是 `default / outline / success / warning / error / muted`，
  原值在状态未知时会落到无效变体上。

### Verified

- 逐项核对 0.7.0 下的 manifest 字段与校验规则、`PluginContext` 用到的全部 API、
  四个服务契约（`content.posts@1` / `content.pages@1` / `content.taxonomy@1` / `media.library@1`）、
  三张直写表（`rn_posts` / `rn_pages` / `rn_comments`）的最终列清单，以及后台 SDK 的组件与图标集：
  **无破坏性变更**，`src/` 与后台页无需改动接口。
- 本插件不注册前台页面路由，与 0.7.0 新增的路径接管能力（`ctx.routes.overridePath`、
  `rice.permalink`、路径模板引擎）无交集，未采纳也无需采纳。

## [1.0.0] - 2026-10-12

首个版本：把 Typecho 导出的 `.dat` 备份迁移进 RiceNote。

- 顺序解析 `%TYPECHO_BACKUP_0001%` 记录流（表号 + 列签名双重识别），统计并预览内容量。
- 导入分类与标签、文章、独立页面；HTML 正文（含 WordPress 块注释）转为 Markdown，
  含 `<!--markdown-->` 标记的正文按 Markdown 原文导入；自动生成摘要。
- 保留原始时间线（直写 `rn_posts` / `rn_pages` 时间字段）与评论的作者、时间、审核状态及楼中楼关系
  （直写 `rn_comments`，`ip_hash` 复现 comments 插件的 `sha256(siteId|comment|ip)` 规则）。
- 附件默认跳过、正文保留原链接；填写「源站根地址」后下载入媒体库并替换正文旧链接。
- 自定义字段写入插件自有表备查，图片类字段用于设置封面。
- 任务列表与详情、实时进度、失败明细、重复执行自动跳过已导入内容、一键撤销本次导入。

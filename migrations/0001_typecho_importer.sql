-- typecho-importer 插件自有表：导入任务、来源→目标映射、Typecho 自定义字段。
--
-- 三张表都由本插件独自拥有（表名前缀 rn_typecho_importer_，
-- 与官方插件的表无外键关系，跨插件只通过服务契约交互）。

CREATE TABLE IF NOT EXISTS rn_typecho_importer_jobs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id     VARCHAR(64)     NOT NULL DEFAULT 'default',
  file_name   VARCHAR(255)    NOT NULL,
  file_size   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status      VARCHAR(24)     NOT NULL DEFAULT 'parsed',
  -- 原始备份内容：执行阶段重新解析，避免把整份解析结果常驻内存。
  payload     MEDIUMBLOB      NULL,
  stats_json  MEDIUMTEXT      NULL,
  options_json MEDIUMTEXT     NULL,
  progress_json MEDIUMTEXT    NULL,
  warnings_json TEXT          NULL,
  error       VARCHAR(500)    NULL,
  operator_id BIGINT UNSIGNED NULL,
  created_at  DATETIME        NOT NULL,
  updated_at  DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY idx_rn_typecho_jobs_site (site_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rn_typecho_importer_maps (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id      BIGINT UNSIGNED NOT NULL,
  site_id     VARCHAR(64)     NOT NULL DEFAULT 'default',
  -- meta / post / page / comment / attachment / field
  source_type VARCHAR(16)     NOT NULL,
  source_id   BIGINT UNSIGNED NOT NULL,
  target_id   BIGINT UNSIGNED NULL,
  label       VARCHAR(255)    NULL,
  created_at  DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rn_typecho_maps (job_id, source_type, source_id),
  KEY idx_rn_typecho_maps_site (site_id, source_type, source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rn_typecho_importer_fields (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id      BIGINT UNSIGNED NOT NULL,
  site_id     VARCHAR(64)     NOT NULL DEFAULT 'default',
  cid         BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(120)    NOT NULL,
  type        VARCHAR(16)     NOT NULL DEFAULT 'str',
  str_value   TEXT            NULL,
  int_value   BIGINT          NULL,
  float_value DOUBLE          NULL,
  created_at  DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY idx_rn_typecho_fields (job_id, cid),
  KEY idx_rn_typecho_fields_name (site_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

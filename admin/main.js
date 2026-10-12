/**
 * 「Typecho 导入」后台界面（零构建 ESM）。
 *
 * 与 navigation 插件的后台页同样的写法：
 * - 只从 `/admin-sdk/v1/ricenote-admin.js` 导入（Vue / Router / 组件都由宿主提供）；
 * - Card、Button、DataTable 等组件已全局注册，模板里直接写标签；
 * - `api` 自带 CSRF 与会话 Cookie，路径是插件自己的管理 API（`/api/admin/...`）。
 *
 * 流程：上传 .dat → 解析预览 → 勾选导入项 → 执行（轮询进度）→ 结果报告 → 历史任务/撤销。
 */

import {
  api,
  computed,
  defineAdminPage,
  onMounted,
  onUnmounted,
  ref,
  useSession,
  useToast
} from '/admin-sdk/v1/ricenote-admin.js';

const POLL_INTERVAL_MS = 1500;

const PHASE_LABELS = {
  pending: '准备中',
  terms: '导入分类与标签',
  attachments: '下载附件',
  posts: '导入文章',
  pages: '导入页面',
  timestamps: '回填发布时间',
  comments: '导入评论',
  fields: '保存自定义字段',
  done: '完成',
  failed: '失败'
};

const STATUS_LABELS = {
  parsed: '已解析',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  rolled_back: '已撤销'
};

// Badge 只有 default / outline / success / warning / error / muted 几种语气。
const STATUS_TONES = {
  parsed: 'muted',
  running: 'warning',
  done: 'success',
  failed: 'error',
  canceled: 'muted',
  rolled_back: 'muted'
};

function messageOf(error) {
  return error && error.message ? error.message : '操作失败，请稍后重试';
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (input) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default defineAdminPage({
  title: 'Typecho 导入',
  description: '把 Typecho 导出的 .dat 备份迁移到本站：上传备份、预览统计、按类型导入，并保留原始时间线。',

  setup() {
    const session = useSession();
    const toast = useToast();

    const settings = ref({ originBaseUrl: '', excerptLength: 120, importComments: true });
    const pickedFile = ref(null);
    const uploading = ref(false);
    const starting = ref(false);

    const currentJob = ref(null);
    const authors = ref([]);
    const authorId = ref('');
    const history = ref([]);
    const historyLoading = ref(false);

    const include = ref({ terms: true, posts: true, pages: true, comments: true, attachments: false, fields: true });
    const excerptLength = ref(120);
    const downloadAttachments = ref(false);
    const dryRun = ref(false);

    const confirmOpen = ref(false);
    const rollbackTarget = ref(null);
    const rollbackLoading = ref(false);

    let pollTimer = null;

    const stats = computed(() => currentJob.value?.stats ?? null);
    const progress = computed(() => currentJob.value?.progress ?? null);
    const isRunning = computed(() => currentJob.value?.status === 'running');
    const percent = computed(() => {
      const value = progress.value;
      if (!value || !value.total) return 0;
      return Math.min(100, Math.round((value.processed / value.total) * 100));
    });
    const phaseLabel = computed(() => PHASE_LABELS[progress.value?.phase] ?? '准备中');
    const canOperate = computed(() => session.can('post.write'));
    const attachmentHint = computed(() =>
      settings.value.originBaseUrl
        ? `已配置源站 ${settings.value.originBaseUrl}，勾选后会把附件下载到媒体库并替换正文链接。`
        : '插件设置里还没有填写「源站根地址」，附件不会被导入，正文保留原链接。'
    );

    const authorOptions = computed(() =>
      authors.value.length > 0
        ? authors.value
        : authorId.value
          ? [{ label: '当前登录用户', value: authorId.value }]
          : []
    );

    const summaryCards = computed(() => {
      const value = stats.value;
      if (!value) return [];
      return [
        { label: '文章', value: value.posts, hint: `其中 ${value.htmlContents} 篇需转 Markdown` },
        { label: '页面', value: value.pages, hint: '独立页面' },
        { label: '分类', value: value.categories, hint: '' },
        { label: '标签', value: value.tags, hint: '' },
        { label: '评论', value: value.comments, hint: '' },
        { label: '附件', value: value.attachments, hint: '需配置源站才能下载' },
        { label: '自定义字段', value: value.fields, hint: '仅存档备查' }
      ];
    });

    const failureRows = computed(() => (progress.value?.failures ?? []).map((item, index) => ({
      id: `${item.sourceType}-${item.sourceId}-${index}`,
      source: `${item.sourceType} #${item.sourceId}`,
      title: item.title ?? '—',
      reason: item.reason
    })));

    const historyColumns = [
      { key: 'fileName', label: '备份文件' },
      { key: 'status', label: '状态', width: 'w-28' },
      { key: 'counters', label: '导入结果', hideBelow: 'md' },
      { key: 'createdAt', label: '时间', width: 'w-40', hideBelow: 'md' },
      { key: 'actions', label: '操作', width: 'w-40', align: 'right' }
    ];

    const failureColumns = [
      { key: 'source', label: '来源', width: 'w-32' },
      { key: 'title', label: '标题' },
      { key: 'reason', label: '原因' }
    ];

    async function loadSettings() {
      try {
        settings.value = await api.get('/typecho/settings');
        excerptLength.value = settings.value.excerptLength || 120;
        include.value.comments = settings.value.importComments !== false;
      } catch {
        /* 设置读取失败就用默认值，不阻塞界面 */
      }
    }

    async function loadAuthors() {
      const currentId = session.user?.id ? String(session.user.id) : '';
      authorId.value = currentId;
      if (!session.can('user.manage')) return;
      try {
        const users = await api.get('/users?pageSize=100');
        const list = Array.isArray(users) ? users : users?.data ?? [];
        authors.value = list.map((user) => ({
          label: user.displayName || user.username || `用户 ${user.id}`,
          value: String(user.id)
        }));
      } catch {
        authors.value = [];
      }
    }

    async function loadHistory() {
      historyLoading.value = true;
      try {
        history.value = await api.get('/typecho/jobs?limit=20');
      } catch (error) {
        toast.error(messageOf(error));
      } finally {
        historyLoading.value = false;
      }
    }

    function onPickFile(event) {
      const input = event.target;
      const file = input.files?.[0] ?? null;
      if (!file) {
        pickedFile.value = null;
        return;
      }
      if (!/\.dat$/i.test(file.name)) {
        toast.error('只支持 Typecho 导出的 .dat 备份文件');
        input.value = '';
        pickedFile.value = null;
        return;
      }
      pickedFile.value = file;
    }

    async function uploadAndParse() {
      if (!pickedFile.value) {
        toast.error('请先选择备份文件');
        return;
      }
      uploading.value = true;
      try {
        const formData = new FormData();
        formData.append('file', pickedFile.value);
        const result = await api.upload('/typecho/parse', formData);
        currentJob.value = {
          id: result.id,
          status: 'parsed',
          stats: result.stats,
          warnings: result.warnings ?? [],
          progress: { phase: 'pending', processed: 0, total: 0, counters: {}, failures: [] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        toast.success(`已解析 ${result.stats.posts} 篇文章、${result.stats.comments} 条评论`);
        await loadHistory();
      } catch (error) {
        toast.error(messageOf(error));
      } finally {
        uploading.value = false;
      }
    }

    async function startImport(isDryRun) {
      if (!currentJob.value) {
        toast.error('请先上传并解析备份文件');
        return;
      }
      starting.value = true;
      try {
        await api.post(`/typecho/jobs/${currentJob.value.id}/run`, {
          include: { ...include.value },
          authorId: Number(authorId.value),
          excerptLength: Number(excerptLength.value) || 120,
          downloadAttachments: downloadAttachments.value === true,
          dryRun: isDryRun === true
        });
        toast.success(isDryRun ? '试运行已开始（不会写入数据）' : '导入已开始');
        startPolling();
      } catch (error) {
        toast.error(messageOf(error));
      } finally {
        starting.value = false;
      }
    }

    async function cancelImport() {
      if (!currentJob.value) return;
      try {
        await api.post(`/typecho/jobs/${currentJob.value.id}/cancel`);
        toast.success('已请求取消');
      } catch (error) {
        toast.error(messageOf(error));
      }
    }

    async function poll() {
      if (!currentJob.value) return;
      try {
        currentJob.value = await api.get(`/typecho/jobs/${currentJob.value.id}`);
        if (currentJob.value.status !== 'running') {
          stopPolling();
          await loadHistory();
        }
      } catch (error) {
        stopPolling();
        toast.error(messageOf(error));
      }
    }

    function startPolling() {
      stopPolling();
      pollTimer = window.setInterval(poll, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function openRollback(job) {
      rollbackTarget.value = job;
      confirmOpen.value = true;
    }

    async function confirmRollback() {
      const job = rollbackTarget.value;
      if (!job) return;
      rollbackLoading.value = true;
      try {
        const result = await api.post(`/typecho/jobs/${job.id}/rollback`);
        toast.success(`已撤销，删除 ${result.removed} 项`);
        if (currentJob.value?.id === job.id) currentJob.value = null;
        await loadHistory();
      } catch (error) {
        toast.error(messageOf(error));
      } finally {
        rollbackLoading.value = false;
        confirmOpen.value = false;
        rollbackTarget.value = null;
      }
    }

    function viewJob(job) {
      api
        .get(`/typecho/jobs/${job.id}`)
        .then((detail) => {
          currentJob.value = detail;
        })
        .catch((error) => toast.error(messageOf(error)));
    }

    onMounted(async () => {
      await Promise.all([loadSettings(), loadAuthors(), loadHistory()]);
    });

    onUnmounted(stopPolling);

    return {
      settings,
      pickedFile,
      uploading,
      starting,
      currentJob,
      include,
      authorId,
      authorOptions,
      excerptLength,
      downloadAttachments,
      dryRun,
      history,
      historyLoading,
      historyColumns,
      failureColumns,
      failureRows,
      summaryCards,
      stats,
      progress,
      isRunning,
      percent,
      phaseLabel,
      canOperate,
      attachmentHint,
      confirmOpen,
      rollbackTarget,
      rollbackLoading,
      onPickFile,
      uploadAndParse,
      startImport,
      cancelImport,
      openRollback,
      confirmRollback,
      viewJob,
      loadHistory,
      formatBytes,
      formatTime,
      statusLabel: (status) => STATUS_LABELS[status] ?? status,
      statusTone: (status) => STATUS_TONES[status] ?? 'secondary'
    };
  },

  template: `
  <div class="space-y-6">
    <!-- 上传区 -->
    <Card>
      <div class="space-y-4 p-5">
        <div>
          <h2 class="text-base font-medium text-foreground">上传备份</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            选择 Typecho 后台导出的 .dat 文件（一般形如 20260928_example.com_xxxx.dat）。
          </p>
        </div>

        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="file"
            accept=".dat"
            class="block w-full max-w-md cursor-pointer rounded-md border border-border bg-background text-sm text-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground"
            @change="onPickFile"
          />
          <Button :loading="uploading" :disabled="!pickedFile || uploading" @click="uploadAndParse">
            上传并解析
          </Button>
        </div>

        <p v-if="pickedFile" class="text-sm text-muted-foreground">
          已选择：{{ pickedFile.name }}（{{ formatBytes(pickedFile.size) }}）
        </p>
      </div>
    </Card>

    <!-- 解析概览 -->
    <Card v-if="stats">
      <div class="space-y-4 p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-base font-medium text-foreground">解析概览</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              任务 #{{ currentJob.id }} · {{ formatBytes(currentJob.fileSize || 0) }} · 共
              {{ stats.posts + stats.pages }} 条内容
            </p>
          </div>
          <Badge :variant="statusTone(currentJob.status)">{{ statusLabel(currentJob.status) }}</Badge>
        </div>

        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div
            v-for="card in summaryCards"
            :key="card.label"
            class="rounded-md border border-border bg-background p-3"
          >
            <p class="text-xs text-muted-foreground">{{ card.label }}</p>
            <p class="mt-1 text-xl font-semibold text-foreground">{{ card.value }}</p>
            <p v-if="card.hint" class="mt-1 text-xs text-muted-foreground">{{ card.hint }}</p>
          </div>
        </div>

        <div v-if="currentJob.warnings && currentJob.warnings.length" class="space-y-2">
          <p class="text-sm font-medium text-foreground">格式提醒</p>
          <ul class="space-y-1 text-sm text-muted-foreground">
            <li v-for="(warning, index) in currentJob.warnings" :key="index">· {{ warning }}</li>
          </ul>
        </div>
      </div>
    </Card>

    <!-- 导入选项 -->
    <Card v-if="stats">
      <div class="space-y-4 p-5">
        <div>
          <h2 class="text-base font-medium text-foreground">导入选项</h2>
          <p class="mt-1 text-sm text-muted-foreground">可以只导入其中一部分，重复执行会自动跳过已导入的内容。</p>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-3">
            <label class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span class="text-sm text-foreground">分类与标签</span>
              <Switch v-model="include.terms" />
            </label>
            <label class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span class="text-sm text-foreground">文章（{{ stats.posts }}）</span>
              <Switch v-model="include.posts" />
            </label>
            <label class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span class="text-sm text-foreground">独立页面（{{ stats.pages }}）</span>
              <Switch v-model="include.pages" />
            </label>
            <label class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span class="text-sm text-foreground">评论（{{ stats.comments }}）</span>
              <Switch v-model="include.comments" />
            </label>
            <label class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span class="text-sm text-foreground">附件（{{ stats.attachments }}）</span>
              <Switch v-model="include.attachments" />
            </label>
            <label class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span class="text-sm text-foreground">自定义字段（{{ stats.fields }}）</span>
              <Switch v-model="include.fields" />
            </label>
          </div>

          <div class="space-y-4">
            <div class="space-y-1.5">
              <Label for="typecho-author">内容归属作者</Label>
              <Select id="typecho-author" v-model="authorId" :options="authorOptions" />
              <p class="text-xs text-muted-foreground">Typecho 的作者不会在本站重建，内容统一归属所选用户。</p>
            </div>

            <div class="space-y-1.5">
              <Label for="typecho-excerpt">摘要长度（字）</Label>
              <Input id="typecho-excerpt" v-model="excerptLength" type="number" min="20" max="500" />
            </div>

            <label class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span class="text-sm text-foreground">下载附件到媒体库</span>
              <Switch v-model="downloadAttachments" />
            </label>
            <p class="text-xs text-muted-foreground">{{ attachmentHint }}</p>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button v-if="canOperate" :loading="starting" :disabled="isRunning || starting" @click="startImport(false)">
            开始导入
          </Button>
          <Button
            v-if="canOperate"
            variant="outline"
            :disabled="isRunning || starting"
            @click="startImport(true)"
          >
            试运行（不写库）
          </Button>
          <Button v-if="isRunning" variant="destructive" @click="cancelImport">取消</Button>
        </div>
      </div>
    </Card>

    <!-- 进度 -->
    <Card v-if="progress && (isRunning || progress.phase !== 'pending')">
      <div class="space-y-4 p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-base font-medium text-foreground">{{ phaseLabel }}</h2>
          <span class="text-sm text-muted-foreground">
            {{ progress.processed }} / {{ progress.total }}（{{ percent }}%）
          </span>
        </div>

        <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div class="h-full bg-primary transition-all" :style="{ width: percent + '%' }"></div>
        </div>

        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">分类标签</p>
            <p class="mt-1 text-lg font-semibold">{{ progress.counters.terms || 0 }}</p>
          </div>
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">文章</p>
            <p class="mt-1 text-lg font-semibold">{{ progress.counters.posts || 0 }}</p>
          </div>
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">页面</p>
            <p class="mt-1 text-lg font-semibold">{{ progress.counters.pages || 0 }}</p>
          </div>
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">评论</p>
            <p class="mt-1 text-lg font-semibold">{{ progress.counters.comments || 0 }}</p>
          </div>
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">附件</p>
            <p class="mt-1 text-lg font-semibold">{{ progress.counters.attachments || 0 }}</p>
          </div>
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">自定义字段</p>
            <p class="mt-1 text-lg font-semibold">{{ progress.counters.fields || 0 }}</p>
          </div>
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">跳过</p>
            <p class="mt-1 text-lg font-semibold">{{ progress.counters.skipped || 0 }}</p>
          </div>
          <div class="rounded-md border border-border bg-background p-3">
            <p class="text-xs text-muted-foreground">失败</p>
            <p class="mt-1 text-lg font-semibold text-destructive">{{ failureRows.length }}</p>
          </div>
        </div>

        <p v-if="currentJob.error" class="text-sm text-destructive">{{ currentJob.error }}</p>

        <DataTable
          v-if="failureRows.length"
          :columns="failureColumns"
          :rows="failureRows"
          empty-title="没有失败项"
        >
          <template #cell-title="{ row }">
            <span class="line-clamp-2">{{ row.title }}</span>
          </template>
          <template #cell-reason="{ row }">
            <span class="text-destructive">{{ row.reason }}</span>
          </template>
        </DataTable>
      </div>
    </Card>

    <!-- 历史任务 -->
    <Card>
      <div class="space-y-4 p-5">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base font-medium text-foreground">历史任务</h2>
          <Button variant="outline" size="sm" @click="loadHistory">刷新</Button>
        </div>

        <DataTable
          :columns="historyColumns"
          :rows="history"
          :loading="historyLoading"
          empty-title="还没有导入任务"
          empty-description="上传一个 .dat 备份文件即可开始迁移"
        >
          <template #cell-fileName="{ row }">
            <div class="min-w-0">
              <p class="truncate text-sm text-foreground">{{ row.fileName }}</p>
              <p class="text-xs text-muted-foreground">{{ formatBytes(row.fileSize) }}</p>
            </div>
          </template>
          <template #cell-status="{ row }">
            <Badge :variant="statusTone(row.status)">{{ statusLabel(row.status) }}</Badge>
          </template>
          <template #cell-counters="{ row }">
            <span class="text-sm text-muted-foreground">
              {{ row.counters?.posts || 0 }} 篇 · {{ row.counters?.comments || 0 }} 评 ·
              {{ row.counters?.skipped || 0 }} 跳过
            </span>
          </template>
          <template #cell-createdAt="{ row }">
            <span class="text-sm text-muted-foreground">{{ formatTime(row.createdAt) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-2">
              <Button variant="outline" size="sm" @click="viewJob(row)">详情</Button>
              <Button variant="destructive" size="sm" @click="openRollback(row)">撤销</Button>
            </div>
          </template>
        </DataTable>
      </div>
    </Card>

    <ConfirmDialog
      :open="confirmOpen"
      title="撤销本次导入"
      :message="rollbackTarget ? \`将删除任务 #\${rollbackTarget.id} 导入的文章、页面、评论与媒体（共 \${(rollbackTarget.counters?.posts || 0) + (rollbackTarget.counters?.pages || 0) + (rollbackTarget.counters?.comments || 0)} 项），此操作不可恢复。\` : ''"
      confirm-label="确认撤销"
      tone="destructive"
      :loading="rollbackLoading"
      @update:open="confirmOpen = $event"
      @confirm="confirmRollback"
    />
  </div>
  `
});

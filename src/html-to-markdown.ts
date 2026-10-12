/**
 * 轻量 HTML → Markdown 转换器。
 *
 * 为什么自己写：备份里大量正文是从 WordPress / Typecho 编辑器带过来的 HTML，
 * 而本插件要以 git 方式分发（安装器不执行依赖安装），运行时依赖必须为零，
 * 仓库里也只有 md→html 方向的 `marked`，没有反向实现。
 *
 * 覆盖范围以真实备份为准：标题、段落、引用、有序/无序列表（含嵌套）、
 * 代码块、图片、链接、强调、删除线、分隔线、换行、表格、figure。
 * 未识别的标签退化为"取文本内容"，宁可少一点格式，也不要丢内容。
 */

interface TextNode {
  type: 'text';
  value: string;
}

interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

type Node = TextNode | ElementNode;

/** 自闭合（无内容）标签。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
]);

/** 块级标签：渲染时需要独立成段。 */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
]);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™'
};

/**
 * 把 HTML 转成 Markdown。
 *
 * 不抛异常：解析失败时逐段降级，保证导入流程不会被一段畸形 HTML 打断。
 */
export function htmlToMarkdown(html: string): string {
  const cleaned = cleanHtml(html);
  if (cleaned.length === 0) return '';

  const root = parseHtml(cleaned);
  const markdown = renderBlocks(root.children, 0);
  return normalizeOutput(markdown);
}

/* ------------------------------- 清洗与实体 ------------------------------- */

/**
 * 清洗：去掉脚本/样式/注释（含 WordPress 的 `<!-- wp:xxx -->` 块注释），
 * 把换行统一成 `\n`（备份里常见 `\r\n`，不统一会让后续切行错乱）。
 */
function cleanHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n');
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/* --------------------------------- 解析 --------------------------------- */

/** 把 HTML 解析成极简节点树；标签不闭合时按栈自动闭合。 */
function parseHtml(html: string): ElementNode {
  const root: ElementNode = { type: 'element', tag: 'root', attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const tokenPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null = tokenPattern.exec(html);

  while (match !== null) {
    if (match.index > lastIndex) {
      pushText(stack[stack.length - 1] as ElementNode, html.slice(lastIndex, match.index));
    }
    lastIndex = tokenPattern.lastIndex;

    const [, closing = '', rawTag = '', rawAttrs = ''] = match;
    const tag = rawTag.toLowerCase();

    if (closing.length > 0) {
      // 找到栈中最近的同名开标签并闭合到它；找不到就忽略这个闭标签。
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]?.tag === tag) {
          stack.length = index;
          break;
        }
      }
    } else {
      const element: ElementNode = {
        type: 'element',
        tag,
        attrs: parseAttributes(rawAttrs),
        children: []
      };
      (stack[stack.length - 1] as ElementNode).children.push(element);

      const isSelfClosed = /\/\s*$/.test(rawAttrs) || VOID_TAGS.has(tag);
      if (!isSelfClosed) stack.push(element);
    }

    match = tokenPattern.exec(html);
  }

  if (lastIndex < html.length) {
    pushText(stack[stack.length - 1] as ElementNode, html.slice(lastIndex));
  }
  return root;
}

function pushText(parent: ElementNode, raw: string): void {
  if (raw.length === 0) return;
  parent.children.push({ type: 'text', value: raw });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null = pattern.exec(raw);
  while (match !== null) {
    const [, name = '', double = '', single = '', bare = ''] = match;
    attrs[name.toLowerCase()] = decodeEntities(double || single || bare);
    match = pattern.exec(raw);
  }
  return attrs;
}

/* --------------------------------- 渲染 --------------------------------- */

function renderBlocks(nodes: Node[], depth: number): string {
  const blocks: string[] = [];
  let inline = '';

  const flush = (): void => {
    const trimmed = inline.trim();
    if (trimmed.length > 0) blocks.push(trimmed);
    inline = '';
  };

  for (const node of nodes) {
    if (node.type === 'text') {
      const text = collapseText(decodeEntities(node.value));
      if (text.trim().length > 0) inline += text;
      continue;
    }

    const tag = node.tag;
    if (tag === 'br') {
      inline += '  \n';
      continue;
    }
    if (tag === 'hr') {
      flush();
      blocks.push('---');
      continue;
    }
    if (tag === 'pre') {
      flush();
      blocks.push(renderPre(node));
      continue;
    }
    if (tag === 'blockquote') {
      flush();
      const inner = renderBlocks(node.children, depth);
      if (inner.length > 0) blocks.push(prefixLines(inner, '> '));
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      const rendered = renderList(node, depth);
      if (rendered.length > 0) blocks.push(rendered);
      continue;
    }
    if (tag === 'table') {
      flush();
      const rendered = renderTable(node);
      if (rendered.length > 0) blocks.push(rendered);
      continue;
    }
    if (tag === 'li') {
      // 游离的 li（父级列表缺失）按列表项处理，避免丢内容。
      flush();
      const rendered = renderListItem(node, depth, '- ');
      if (rendered.length > 0) blocks.push(rendered);
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      flush();
      const level = Number(tag.slice(1));
      const text = collapseText(renderInline(node.children)).trim();
      if (text.length > 0) blocks.push(`${'#'.repeat(level)} ${text}`);
      continue;
    }
    if (tag === 'p' || tag === 'figcaption') {
      flush();
      const text = collapseText(renderInline(node.children)).trim();
      if (text.length > 0) blocks.push(text);
      continue;
    }
    if (tag === 'img') {
      flush();
      const image = renderImage(node);
      if (image.length > 0) blocks.push(image);
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      // div/figure/section 这类容器：直接展开子块，不额外加空行。
      flush();
      const inner = renderBlocks(node.children, depth);
      if (inner.length > 0) blocks.push(inner);
      continue;
    }

    inline += renderInline([node]);
  }

  flush();
  return blocks.join('\n\n');
}

function renderPre(node: ElementNode): string {
  const codeNode = findFirst(node.children, 'code');
  const source = codeNode ?? node;
  const text = collectRawText(source).replace(/\n+$/, '');
  const className = source.type === 'element' ? (source.attrs.class ?? '') : '';
  const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? '';
  return `\`\`\`${language}\n${text}\n\`\`\``;
}

function renderList(node: ElementNode, depth: number): string {
  const ordered = node.tag === 'ol';
  const items = node.children.filter(
    (child): child is ElementNode => child.type === 'element' && child.tag === 'li'
  );
  const start = Number(node.attrs.start ?? '1');
  return items
    .map((item, index) =>
      renderListItem(item, depth, ordered ? `${(Number.isFinite(start) ? start : 1) + index}. ` : '- ')
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

function renderListItem(node: ElementNode, depth: number, marker: string): string {
  const indent = '  '.repeat(depth);
  const body = renderBlocks(node.children, depth + 1);
  if (body.length === 0) return `${indent}${marker}`.trimEnd();
  const [first = '', ...rest] = body.split('\n');
  const lines = [`${indent}${marker}${first}`];
  for (const line of rest) {
    lines.push(`${'  '.repeat(depth + 1)}${line}`);
  }
  return lines.join('\n');
}

function renderTable(node: ElementNode): string {
  const rows = collectTableRows(node);
  if (rows.length === 0) return '';

  const [header = [], ...body] = rows;
  const width = Math.max(header.length, ...body.map((row) => row.length));
  if (width === 0) return '';

  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, index) => (row[index] ?? '').replace(/\|/g, '\\|'));

  const lines = [
    `| ${pad(header).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  ];
  for (const row of body) {
    lines.push(`| ${pad(row).join(' | ')} |`);
  }
  return lines.join('\n');
}

function collectTableRows(node: ElementNode): string[][] {
  const rows: string[][] = [];
  const walk = (element: ElementNode): void => {
    if (element.tag === 'tr') {
      const cells = element.children
        .filter((child): child is ElementNode => child.type === 'element' && /^t[hd]$/.test(child.tag))
        .map((cell) => collapseText(renderInline(cell.children)).trim());
      if (cells.length > 0) rows.push(cells);
      return;
    }
    for (const child of element.children) {
      if (child.type === 'element') walk(child);
    }
  };
  walk(node);
  return rows;
}

function renderInline(nodes: Node[]): string {
  let output = '';

  for (const node of nodes) {
    if (node.type === 'text') {
      output += collapseText(decodeEntities(node.value));
      continue;
    }

    const text = renderInline(node.children);
    switch (node.tag) {
      case 'strong':
      case 'b':
        output += wrap('**', text);
        break;
      case 'em':
      case 'i':
        output += wrap('*', text);
        break;
      case 'del':
      case 's':
      case 'strike':
        output += wrap('~~', text);
        break;
      case 'code':
      case 'kbd':
      case 'samp':
        output += wrapInlineCode(text);
        break;
      case 'a': {
        const href = node.attrs.href ?? '';
        if (href.length === 0) {
          output += text;
          break;
        }
        const label = text.trim().length > 0 ? text.trim() : href;
        output += `[${label.replace(/\]/g, '\\]')}](${href})`;
        break;
      }
      case 'img':
        output += renderImage(node);
        break;
      case 'br':
        output += '  \n';
        break;
      case 'sup':
      case 'sub':
      case 'mark':
      case 'span':
      case 'small':
        output += text;
        break;
      default:
        // 未知标签（含 div 等容器出现在内联上下文中）：只取内容，避免丢字。
        output += text.length > 0 ? text : '';
    }
  }

  return output;
}

function renderImage(node: ElementNode): string {
  const src = node.attrs.src ?? '';
  if (src.length === 0) return '';
  const alt = (node.attrs.alt ?? '').replace(/\]/g, '\\]');
  return `![${alt}](${src})`;
}

function wrap(marker: string, text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return `${marker}${trimmed}${marker}`;
}

function wrapInlineCode(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const fence = trimmed.includes('`') ? '``' : '`';
  return `${fence} ${trimmed} ${fence}`;
}

function findFirst(nodes: Node[], tag: string): ElementNode | undefined {
  for (const node of nodes) {
    if (node.type === 'element') {
      if (node.tag === tag) return node;
      const found = findFirst(node.children, tag);
      if (found) return found;
    }
  }
  return undefined;
}

/** 代码块内容按原样保留（不做实体解码之外的清洗）。 */
function collectRawText(node: Node): string {
  if (node.type === 'text') return node.value;
  return node.children.map((child) => collectRawText(child)).join('');
}

function collapseText(input: string): string {
  return input.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `${prefix}${line}`))
    .join('\n');
}

/** 收敛多余空行与行尾空格。 */
function normalizeOutput(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

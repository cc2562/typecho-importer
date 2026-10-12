/**
 * PHP `serialize()` 的极简解析器。
 *
 * 用途只有一个：Typecho 的附件条目把元信息存在 `contents.text` 里，
 * 老数据是 `a:5:{s:4:"name";...}` 这种 PHP 序列化串，新数据已经是 JSON。
 * 只支持备份里真正会出现的类型：`a` / `s` / `i` / `d` / `b` / `N` / `O`。
 *
 * 之所以自己写而不引第三方库：本插件要以 git 方式分发，
 * 安装器不会为它执行依赖安装（见 README），运行时依赖必须为零。
 */

interface Cursor {
  pos: number;
}

/** 解析失败时抛出，调用方按「未知格式」降级处理。 */
export class PhpSerializeError extends Error {}

/**
 * 解析 PHP 序列化字符串。
 *
 * @throws {PhpSerializeError} 格式非法或出现不支持的类型（如对象引用 `R`）。
 */
export function parsePhpSerialize(input: string): unknown {
  const buf = Buffer.from(input, 'utf8');
  const cursor: Cursor = { pos: 0 };
  const value = readValue(buf, cursor);
  skipTrailing(buf, cursor);
  return value;
}

/** 尝试解析，失败返回 undefined（用于「可能是 JSON 也可能是 serialize」的场景）。 */
export function tryParsePhpSerialize(input: string): unknown | undefined {
  try {
    return parsePhpSerialize(input);
  } catch {
    return undefined;
  }
}

function readValue(buf: Buffer, cursor: Cursor): unknown {
  if (cursor.pos >= buf.length) throw new PhpSerializeError('意外的结尾');
  const marker = String.fromCharCode(buf[cursor.pos] as number);

  switch (marker) {
    case 'N':
      expect(buf, cursor, 'N;');
      return null;
    case 'b':
      return readBoolean(buf, cursor);
    case 'i':
      return readInteger(buf, cursor);
    case 'd':
    case 'D':
      return readFloat(buf, cursor, marker);
    case 's':
      return readString(buf, cursor);
    case 'a':
      return readArray(buf, cursor);
    case 'O':
      return readObject(buf, cursor);
    default:
      throw new PhpSerializeError(`不支持的序列化类型：${marker}`);
  }
}

function readBoolean(buf: Buffer, cursor: Cursor): boolean {
  expect(buf, cursor, 'b:');
  const digit = readUntil(buf, cursor, ';');
  if (digit === '1') return true;
  if (digit === '0') return false;
  throw new PhpSerializeError(`非法布尔值：${digit}`);
}

function readInteger(buf: Buffer, cursor: Cursor): number {
  expect(buf, cursor, 'i:');
  const raw = readUntil(buf, cursor, ';');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new PhpSerializeError(`非法整数：${raw}`);
  return value;
}

function readFloat(buf: Buffer, cursor: Cursor, marker: string): number {
  expect(buf, cursor, `${marker}:`);
  const raw = readUntil(buf, cursor, ';');
  if (raw === 'INF' || raw === '-INF' || raw === 'NAN') return Number(raw);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new PhpSerializeError(`非法浮点数：${raw}`);
  return value;
}

function readString(buf: Buffer, cursor: Cursor): string {
  expect(buf, cursor, 's:');
  const lengthRaw = readUntil(buf, cursor, ':');
  const length = Number(lengthRaw);
  if (!Number.isInteger(length) || length < 0) {
    throw new PhpSerializeError(`非法字符串长度：${lengthRaw}`);
  }
  expect(buf, cursor, '"');
  if (cursor.pos + length > buf.length) throw new PhpSerializeError('字符串长度越界');

  /*
   * 长度以**字节**计，按字节切片再解码，否则中文会截断。
   *
   * 容错：真实备份里出现过"声明长度比实际少 1 字节"的序列化串
   * （例如 `s:35:"/usr/uploads/2025/09/3003830580.avif"` 实际 36 字节），
   * 严格校验会让整条附件记录报废。声明位置不是 `";` 边界时，
   * 向前扫到最近的 `";` 再收尾——宁可多读一点，也不要丢掉整条附件。
   */
  let end = cursor.pos + Math.max(0, length);
  if (!isStringBoundary(buf, end)) {
    const recovered = findStringBoundary(buf, cursor.pos, end);
    if (recovered === undefined) throw new PhpSerializeError('字符串缺少结束引号');
    end = recovered;
  }

  const value = buf.subarray(cursor.pos, end).toString('utf8');
  cursor.pos = end;
  expect(buf, cursor, '"');
  expect(buf, cursor, ';');
  return value;
}

const QUOTE = 0x22;
const SEMICOLON = 0x3b;

/** 该位置是否是字符串的结束引号（后紧跟 `;`）。 */
function isStringBoundary(buf: Buffer, index: number): boolean {
  return buf[index] === QUOTE && buf[index + 1] === SEMICOLON;
}

/**
 * 从 `from` 开始找最近的 `";`。
 *
 * 优先信任声明长度附近的位置：真实数据只见过 ±1 的偏差，
 * 限定在小窗口内搜索可以避免字符串里含引号时误判到很远的地方，
 * 窗口内找不到再放宽到全文（宁可解析出略长的串，也不丢内容）。
 */
function findStringBoundary(buf: Buffer, from: number, declaredEnd: number): number | undefined {
  const windowStart = Math.max(from, declaredEnd - 2);
  const windowEnd = Math.min(buf.length - 1, declaredEnd + 8);
  for (let index = windowStart; index <= windowEnd; index += 1) {
    if (isStringBoundary(buf, index)) return index;
  }
  for (let index = from; index + 1 < buf.length; index += 1) {
    if (isStringBoundary(buf, index)) return index;
  }
  return undefined;
}

function readArray(buf: Buffer, cursor: Cursor): unknown[] | Record<string, unknown> {
  expect(buf, cursor, 'a:');
  const countRaw = readUntil(buf, cursor, ':');
  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 0) {
    throw new PhpSerializeError(`非法数组长度：${countRaw}`);
  }
  expect(buf, cursor, '{');

  const keys: Array<number | string> = [];
  const values: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = readValue(buf, cursor);
    if (typeof key !== 'number' && typeof key !== 'string') {
      throw new PhpSerializeError('数组键必须是整数或字符串');
    }
    keys.push(key);
    values.push(readValue(buf, cursor));
  }
  expect(buf, cursor, '}');

  return toJsContainer(keys, values);
}

function readObject(buf: Buffer, cursor: Cursor): Record<string, unknown> {
  expect(buf, cursor, 'O:');
  const nameLengthRaw = readUntil(buf, cursor, ':');
  const nameLength = Number(nameLengthRaw);
  if (!Number.isInteger(nameLength) || nameLength < 0) {
    throw new PhpSerializeError(`非法类名长度：${nameLengthRaw}`);
  }
  expect(buf, cursor, '"');
  cursor.pos += nameLength; // 类名只用于定位，不参与结果
  expect(buf, cursor, '"');
  expect(buf, cursor, ':');

  const countRaw = readUntil(buf, cursor, ':');
  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 0) {
    throw new PhpSerializeError(`非法属性数量：${countRaw}`);
  }
  expect(buf, cursor, '{');

  const result: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    const key = readValue(buf, cursor);
    result[String(key)] = readValue(buf, cursor);
  }
  expect(buf, cursor, '}');
  return result;
}

/**
 * PHP 的数组既当列表又当字典：
 * 键为 0..n-1 连续整数时映射成 JS 数组，否则映射成对象。
 */
function toJsContainer(
  keys: Array<number | string>,
  values: unknown[]
): unknown[] | Record<string, unknown> {
  const isSequentialList = keys.every((key, index) => typeof key === 'number' && key === index);
  if (isSequentialList) return values;

  const result: Record<string, unknown> = {};
  keys.forEach((key, index) => {
    result[String(key)] = values[index];
  });
  return result;
}

function expect(buf: Buffer, cursor: Cursor, literal: string): void {
  if (cursor.pos + literal.length > buf.length) throw new PhpSerializeError('意外的结尾');
  const actual = buf.subarray(cursor.pos, cursor.pos + literal.length).toString('latin1');
  if (actual !== literal) {
    throw new PhpSerializeError(`期望 "${literal}"，实际 "${actual}"`);
  }
  cursor.pos += literal.length;
}

/** 读取到下一个 `stop` 字符（不含），并跳过该字符。 */
function readUntil(buf: Buffer, cursor: Cursor, stop: string): string {
  const start = cursor.pos;
  while (cursor.pos < buf.length && String.fromCharCode(buf[cursor.pos] as number) !== stop) {
    cursor.pos += 1;
  }
  if (cursor.pos >= buf.length) throw new PhpSerializeError('意外的结尾');
  const raw = buf.subarray(start, cursor.pos).toString('latin1');
  cursor.pos += 1;
  return raw;
}

/** 末尾允许空白（备份里偶有换行），有其他内容则视为格式错误。 */
function skipTrailing(buf: Buffer, cursor: Cursor): void {
  while (cursor.pos < buf.length) {
    const char = String.fromCharCode(buf[cursor.pos] as number);
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      cursor.pos += 1;
      continue;
    }
    throw new PhpSerializeError('序列化串结尾存在多余内容');
  }
}

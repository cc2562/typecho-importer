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
/** 解析失败时抛出，调用方按「未知格式」降级处理。 */
export declare class PhpSerializeError extends Error {
}
/**
 * 解析 PHP 序列化字符串。
 *
 * @throws {PhpSerializeError} 格式非法或出现不支持的类型（如对象引用 `R`）。
 */
export declare function parsePhpSerialize(input: string): unknown;
/** 尝试解析，失败返回 undefined（用于「可能是 JSON 也可能是 serialize」的场景）。 */
export declare function tryParsePhpSerialize(input: string): unknown | undefined;
//# sourceMappingURL=php-serialize.d.ts.map
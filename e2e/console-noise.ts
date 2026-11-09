/**
 * Console text the e2e guards ignore, exactly. Firefox warns once per module that compiles the duckdb-wasm `eh`
 * (exception handling) build we ship; the engine is pinned (R47) and the warning is not ours to fix. Firefox wraps the text
 * (`[JavaScript Warning: "..." {file: ...}]`) and appends advice, so a message is ignored when it contains
 * the phrase; the phrase is the whole warning's identity, nothing broader is listed.
 */
const IGNORED_CONSOLE_TEXT = ["The WebAssembly exception handling 'try' instruction is deprecated"];

export function isIgnoredConsole(text: string): boolean {
  return IGNORED_CONSOLE_TEXT.some((ignored) => text.includes(ignored));
}

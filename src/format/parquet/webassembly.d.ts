// parquet-wasm's typings name `WebAssembly.Table` and `WebAssembly.Memory`, which the ES2024 lib (no DOM) lacks.
// Declared here, minimally, so the typecheck does not need `skipLibCheck` or the DOM lib.
declare namespace WebAssembly {
  interface Table {
    readonly length: number;
  }
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
}

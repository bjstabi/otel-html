import { defineConfig, type UserConfig } from 'tsdown';

// The CLI entry (`cli/main`: src/cli/main.ts) is added with the CLI.
const config: UserConfig = defineConfig({
  entry: { index: 'src/api/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: 'dist',
});

export default config;

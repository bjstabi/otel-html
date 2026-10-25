import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  entry: { index: 'src/api/index.ts', 'cli/main': 'src/cli/main.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: 'dist',
});

export default config;

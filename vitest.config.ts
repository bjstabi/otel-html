import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/viewer/**', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'viewer',
          environment: 'jsdom',
          include: ['test/viewer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});

export default config;

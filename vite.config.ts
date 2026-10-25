import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type UserConfig } from 'vite';

// A classic IIFE bundle: index.html loads it with a plain <script src>, which works from file://.
const config: UserConfig = defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/viewer',
    emptyOutDir: true,
    manifest: true,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/viewer/main.tsx',
      output: {
        format: 'iife',
        entryFileNames: 'assets/viewer.[hash].js',
        assetFileNames: 'assets/viewer.[hash][extname]',
      },
    },
  },
});

export default config;

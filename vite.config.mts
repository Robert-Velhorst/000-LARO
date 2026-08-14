import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const devApiUrl = process.env.VITE_LARO_API_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  envDir: process.env.VITE_LARO_IGNORE_DOTENV === 'true' ? false : undefined,

  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src/renderer'),
      'radix-ui': path.resolve(import.meta.dirname, './src/renderer/lib/radix-ui.ts'),
    },
  },

  // Must be './' so Electron can load the built index.html as a local file
  base: './',

  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },

  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/*.sqlite',
        '**/*.sqlite-*',
        '**/laro-uploads/**',
        '**/test-results/**',
      ],
    },
    proxy: {
      '/api': {
        target: devApiUrl,
        changeOrigin: true,
      },
      '/socket.io': {
        target: devApiUrl,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const API_PORT = process.env.PORT ?? '3000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
  build: {
    rollupOptions: {
      // Two separate HTML entries so the server can serve the login page statically
      // without auth while gating every other page behind a session check.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        login: fileURLToPath(new URL('./login.html', import.meta.url)),
      },
    },
  },
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
});

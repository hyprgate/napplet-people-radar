import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['module', 'browser', 'development|production'], dedupe: ['svelte'] },
  test: {
    environment: 'jsdom',
  },
});

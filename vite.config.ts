import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    nip5aManifest({
      nappletType: 'people-radar',
      requires: ['identity', 'relay', 'inc', 'storage', 'intent', 'common', 'resource'],
      optional: ['theme', 'outbox'],
      icon: { data: readFileSync(new URL('./icon.png', import.meta.url)), mimeType: 'image/png' },
      artifactMode: 'single-file',
    }),
  ],
  resolve: { dedupe: ['svelte'] },
  server: { port: 9508, cors: true },
  build: { outDir: 'dist' },
});

import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    noExternal: ['phaser'], // 👈 prevents SSR evaluation
  },
});

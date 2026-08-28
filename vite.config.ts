import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // The whole game is one bundle. It is small, and a single request beats
    // waterfalling chunks on a phone.
    rollupOptions: { output: { manualChunks: undefined } }
  },
  server: { host: true }
});

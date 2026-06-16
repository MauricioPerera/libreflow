import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Config de tests del frontend: plugin Vue para montar SFCs + jsdom para el DOM.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
  },
});

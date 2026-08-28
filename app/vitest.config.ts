import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    passWithNoTests: true,
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/.databricks/**'],
    // Transformed by Vite rather than loaded by Node, because the package imports
    // `echarts-for-react/esm/core` without a file extension: Vite resolves that and Node's ESM
    // resolver refuses it. Left external, no test can import a page that renders an Alert or a
    // Spinner, and the error names echarts rather than the page it could not import.
    server: { deps: { inline: ['@databricks/appkit-ui'] } },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
    },
  },
});

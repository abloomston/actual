import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/actual-node-client/mcp-api.test.mjs'],
  },
});

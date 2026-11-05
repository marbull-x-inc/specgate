// Harness only: the four middleware in scope, without hono's multi-project config.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['src/middleware/{cors,secure-headers,body-limit,request-id}/*.test.ts'],
  },
})

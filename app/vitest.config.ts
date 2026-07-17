import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The integration suite runs the REAL PyInstaller sidecar; a full
    // list + one no-files md export takes seconds each, so be generous.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})

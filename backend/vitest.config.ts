import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites touch the same on-disk SQLite file via initDatabase(); running
    // test files in parallel makes them contend for the write lock (SQLITE_BUSY).
    // The app uses a single connection in production, so this is purely a test artifact.
    fileParallelism: false,
  },
});

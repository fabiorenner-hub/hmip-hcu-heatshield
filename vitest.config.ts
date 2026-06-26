import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Classic JSX with the Preact `h` / `Fragment` pragma, mirroring the
    // SPA's production esbuild bundle (Task 11.5).
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'tests/property/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup/i18n-de.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});

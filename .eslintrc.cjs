/* eslint-env node */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: false,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'node_modules/', '.tmp-assets/', 'coverage/'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // Service worker runs in the ServiceWorkerGlobalScope: `self`, `caches`,
      // `clients`, `fetch` are ambient globals, not Node ones.
      files: ['src/plugin/dashboard/public/sw.js'],
      env: {
        browser: true,
        serviceworker: true,
        node: false,
      },
      rules: {
        'no-undef': 'off',
      },
    },
    {
      // SPA sources use TSX with the Preact JSX runtime. The default parser
      // options + `@typescript-eslint` are happy with `.tsx`, we just need
      // to enable the JSX flag so the parser accepts JSX syntax.
      files: ['src/plugin/dashboard/spa/**/*.{ts,tsx}', 'tests/**/*.tsx'],
      parserOptions: {
        ecmaFeatures: { jsx: true },
        jsxPragma: 'h',
      },
      env: {
        browser: true,
        node: false,
      },
      rules: {
        // Preact's JSX factory is auto-injected by esbuild; we don't need to
        // enforce React-style "no-undef" guards here.
        'no-undef': 'off',
        // Classic JSX runtime: `h` is used implicitly by the transform.
        '@typescript-eslint/no-unused-vars': [
          'warn',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^(_|h$|Fragment$)',
          },
        ],
      },
    },
  ],
};

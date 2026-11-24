import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import svelteConfig from './client/svelte.config.js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      'data/',
      'e2e/playwright-report/',
      'e2e/test-results/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  {
    files: ['client/**/*.{ts,svelte}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
        svelteConfig,
      },
    },
  },

  {
    files: ['client/vite.config.ts', 'client/src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },

  {
    files: ['server/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.{js,mjs}', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
);

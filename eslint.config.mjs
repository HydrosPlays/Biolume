import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      '.smoke/**',
      'node_modules/**',
      // Stream Deck plugin: its dependencies, bundler output and the packed installer.
      'streamdeck/node_modules/**',
      'streamdeck/*.sdPlugin/bin/**',
      'streamdeck/*.sdPlugin/logs/**',
      'build/streamdeck/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts', 'src/shared/**/*.ts', '*.config.{ts,mjs}', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
);

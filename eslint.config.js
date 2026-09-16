import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'worker-configuration.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.test.json', tsconfigRootDir: import.meta.dirname },
      globals: { crypto: 'readonly', console: 'readonly', Request: 'readonly', Response: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-eval': 'error',
    },
  },
);

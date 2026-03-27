// @ts-check
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.eslint.json'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'destructuredArrayIgnorePattern': '^_', 'varsIgnorePattern': '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn'
    }
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    }
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '**/*.js', 'eslint.config.cjs']
  }
);

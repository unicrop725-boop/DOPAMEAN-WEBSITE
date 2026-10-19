import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      'legacy/**',
      'dist/**',
      'public/**',
      '.dependency-cruiser.cjs',
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
    },
  },
  {
    // The storefront deliberately links the original CSS files (ADR 0004).
    files: ['src/app/(storefront)/**', 'src/storefront/**'],
    rules: {
      '@next/next/no-css-tags': 'off',
      '@next/next/no-img-element': 'off',
      '@next/next/no-page-custom-font': 'off',
    },
  },
  { files: ['scripts/**', 'tests/**'], rules: { 'no-console': 'off' } },
);

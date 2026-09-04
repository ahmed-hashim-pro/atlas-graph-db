import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'docs/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
);

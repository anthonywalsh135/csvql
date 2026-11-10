import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  { ignores: ['coverage/', 'bench/data/'] },
  js.configs.recommended,
  {
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      curly: ['error', 'multi-line'],
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  prettier,
];

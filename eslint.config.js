import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  { ignores: ['coverage/', 'bench/data/'] },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      //after the prettier preset, which would otherwise switch this off. a body
      //that prettier has moved onto its own line must be given braces.
      curly: ['error', 'multi-line'],
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];

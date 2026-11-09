// Lint for bugs, not style: undefined names, unused code, unreachable branches.
// The extension is plain scripts (no modules, no build), so globals shared between files are declared here.
import js from '@eslint/js';
import globals from 'globals';

const unused = (vars) => ['warn', { vars, args: 'none', caughtErrors: 'none' }];

export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    // Extension pages, the content script and the service worker.
    files: ['*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions, module: 'readonly' },
    },
    rules: { 'no-unused-vars': unused('local'), 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  // reader.html loads ehentai.js and balloon.js before reader.js.
  { files: ['reader.js'], languageOptions: { globals: { EH: 'readonly', Balloon: 'readonly' } } },
  {
    files: ['tests/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': unused('all'), 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
];

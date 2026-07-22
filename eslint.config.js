import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import noCatchAll from 'eslint-plugin-no-catch-all'

export default [
  { ignores: ['node_modules/', 'dist/', 'container/', 'groups/'] },
  { files: ['src/**/*.{js,ts}'] },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-catch-all/no-catch-all': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Webchat PWA frontend — browser runtime, no build step, vendored globals.
    files: ['public/webchat/app.js', 'public/webchat/sw.js'],
    languageOptions: {
      globals: { ...globals.browser, marked: 'readonly', DOMPurify: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The error-toast bug class: showToast(msg, 'error') destructures a string
      // and silently renders as info. Kind must ride an options object.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='showToast'][arguments.1.type='Literal']",
          message: "showToast's 2nd arg must be an options object ({ kind: … }) — or use toastError().",
        },
      ],
    },
  },
]

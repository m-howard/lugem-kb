import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
// Named import, not default: `eslint-plugin-import-x` exports `flatConfigs` both on its default
// export and as a named export, and reaching it through the default trips the plugin's own
// no-named-as-default-member rule.
import { flatConfigs as importXConfigs } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

/**
 * Import groups, in the order AGENTS.md mandates: built-ins, external packages, internal
 * absolute imports, relative imports, then type-only imports last.
 */
const IMPORT_GROUP_ORDER = [
  'builtin',
  'external',
  'internal',
  ['parent', 'sibling', 'index'],
  'type',
];

/** Values that read fine as literals: sentinels, empty/first checks, and the common pair split. */
const ALLOWED_NUMBERS = [-1, 0, 1, 2];

const MAX_FUNCTION_LINES = 50;
const MAX_FILE_LINES = 500;

/**
 * Declarative resource wiring runs longer than application logic and does not decompose
 * usefully — splitting `createLoadBalancer` into two halves produces a function that exists only
 * to satisfy a line count, and a reader who now has to hold two names instead of one.
 */
const MAX_INFRA_FUNCTION_LINES = 80;

/** Files outside every workspace tsconfig: root configs, scripts, and the Playwright suite. */
const TOOLING_FILES = ['*.config.ts', '*.config.mts', 'scripts/**/*.ts', 'tests/e2e/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.docusaurus/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'apps/gateway/tests/fixtures/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  importXConfigs.recommended,

  // The ESLint config itself is JavaScript, so there is no TypeScript project to check it
  // against. Both the rules and the parser's project lookup have to be switched off — leaving
  // the lookup on makes the parser fail before any rule runs.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: undefined },
    },
  },

  // Scoped to TypeScript: the project service has nothing to say about a `.mjs` config file,
  // and an unscoped block here would re-enable it for one and fail to parse.
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'import-x/order': [
        'error',
        {
          groups: IMPORT_GROUP_ORDER,
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-default-export': 'error',

      // TypeScript resolves modules and checks named exports itself, and `bun run typecheck`
      // fails on anything it cannot find. Duplicating that here would mean installing and
      // configuring a second resolver to re-derive an answer the compiler already gave — and
      // getting false positives on packages whose exports it cannot follow.
      'import-x/no-unresolved': 'off',
      'import-x/namespace': 'off',
      'import-x/named': 'off',
      'import-x/default': 'off',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // AGENTS.md "Code Clarity": no magic numbers, no nested ternaries, bounded functions.
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: ALLOWED_NUMBERS,
          ignoreEnums: true,
          ignoreReadonlyClassProperties: true,
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
        },
      ],
      'no-nested-ternary': 'error',
      'max-params': ['error', 3],
      'max-lines-per-function': [
        'error',
        { max: MAX_FUNCTION_LINES, skipBlankLines: true, skipComments: true },
      ],
      'max-lines': ['error', { max: MAX_FILE_LINES, skipBlankLines: true, skipComments: true }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },

  // Root configs, scripts and the Playwright suite sit outside every workspace tsconfig, so the
  // project service cannot place them. tsconfig.tools.json exists to cover exactly this set.
  {
    files: TOOLING_FILES,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.tools.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // These files are executed directly, so a default export and console output are their
      // interface rather than a smell.
      'import-x/no-default-export': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },

  // Docusaurus loads its config and sidebars by default export; a named export is not read.
  {
    files: ['apps/docs/**/*.ts'],
    rules: { 'import-x/no-default-export': 'off' },
  },

  {
    files: ['infra/pulumi/**/*.ts'],
    rules: {
      'import-x/no-default-export': 'off',
      'max-lines-per-function': [
        'error',
        { max: MAX_INFRA_FUNCTION_LINES, skipBlankLines: true, skipComments: true },
      ],
      // Pulumi resource constructors are used for their side effect on the resource graph;
      // assigning each to an unread variable would be noise.
      'no-new': 'off',
    },
  },

  // Tests assert on literals constantly, and a long table-driven test is a feature.
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  prettier,
);

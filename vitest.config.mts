import { defineConfig } from 'vitest/config';

/**
 * The gate measures code that holds logic. Declarative Pulumi resource wiring is excluded from
 * the denominator — including it would let a stack file of `new aws.s3.Bucket(...)` calls carry
 * the percentage without anything being verified. See docs/adr/0008-coverage-gate-on-logic-only.md.
 */
const COVERAGE_THRESHOLD = 80;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'apps/*/src/**/*.test.ts',
            'infra/*/src/**/*.test.ts',
            // Most of `scripts/` is I/O orchestration, but the CODEOWNERS parser is pure logic
            // that decides who hears about a documentation gap. It is tested like any other.
            'scripts/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/*/tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'apps/gateway/src/**/*.ts',
        'infra/pulumi/src/config.ts',
        'infra/pulumi/src/github-config.ts',
        'scripts/docs/codeowners.ts',
        // The content quality gates (requirements.md R13). Same reasoning as the CODEOWNERS
        // parser: these decide whether a page may be published, so they are measured. The walker
        // and the runner beside them are I/O orchestration and stay out.
        'scripts/docs/frontmatter.ts',
        'scripts/docs/links.ts',
        'scripts/docs/ownership.ts',
        'scripts/docs/problem-report.ts',
      ],
      exclude: ['**/*.test.ts', 'apps/gateway/src/index.ts'],
      thresholds: {
        statements: COVERAGE_THRESHOLD,
        lines: COVERAGE_THRESHOLD,
        functions: COVERAGE_THRESHOLD,
        branches: COVERAGE_THRESHOLD,
      },
    },
  },
});

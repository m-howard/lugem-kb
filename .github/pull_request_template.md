## What and why

<!-- What changes, and what problem it solves. The diff shows what; explain why. -->

## Test plan

<!-- How a reviewer verifies this. Commands they can run, and what they should see. -->

```bash
bun run typecheck
bun run lint && bun run lint:md
bun run test:coverage
```

## Checklist

- [ ] Code under a `src/` is covered by tests in this pull request (unit beside the source,
      integration in the workspace's `tests/`)
- [ ] Documentation updated in this pull request — `docs/` is the corpus the knowledge base
      indexes, so a stale page becomes a confidently wrong answer
- [ ] An ADR is added for any architectural decision, saying what it **costs**
- [ ] New configuration follows the fail-closed rule: required means required, and the error
      names the variable
- [ ] If a gateway route was added, `tests/integration/route-precedence.test.ts` covers it — the
      static site handler must stay mounted last
- [ ] `bun.lock` is the only lockfile touched

## Infrastructure changes

<!-- Delete this section if infra/ is untouched. -->

- [ ] `pulumi preview` output reviewed, and attached or summarised below
- [ ] No IAM policy widened beyond one bucket, one prefix, one knowledge base ARN
- [ ] Cost impact considered and stated

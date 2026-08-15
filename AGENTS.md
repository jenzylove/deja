# Deja Builder Contract

## Product
Deja is a paper-trading decision-memory layer. Preserve the locked scope in `docs/PRD.md` and sequence in `docs/ROADMAP.md`.

## Workspace
- Work only inside this repository.
- `main` is the authoritative branch.
- Do not edit another project.

## Current gate
Implement Phase 3 only: deterministic rule DSL and BLOCK/WARN/PASS evaluation. Do not start UI, brief generation, execution, deployment, or cloud provisioning in this gate.

## Discipline
1. Use strict test-driven development. Add one failing behavior test, run it and record the expected failure, implement the minimum code, then rerun targeted and full checks.
2. Rules compile separately. Evaluation itself must be pure TypeScript with no LLM, network, database, clock, or environment dependency.
3. Supported fields are a closed enum. Unknown fields and operators fail closed.
4. A `block` violation produces BLOCK. A `warn` violation produces WARN unless any block also fails. No violations produce PASS.
5. Return structured evidence for every evaluated rule, including rule ID, field, expected value, actual value, operator, enforcement, and pass/fail.
6. Do not fabricate live CockroachDB or Bedrock results. `.env.local` is absent.
7. No dependency upgrades, cloud changes, deployment, spend, credential reads, or external writes.
8. Keep the diff limited to this gate. Run tests, lint, and production build before handing back.
9. Do not commit or push. The main agent reviews and owns Git delivery.

## Commands
- Install: `npm ci`
- Tests: add a deterministic Node/TypeScript test command to `package.json`
- Lint: `npm run lint`
- Build: `npm run build`

## Completion
Gate passes only when the RED and GREEN evidence is recorded in `BUILD_STATUS.md`, all rule-engine tests pass, lint has no errors, production build passes, and the working diff contains only Phase 3 files.

---
title: Documentation policy
document_type: policy
status: canonical
updated: 2026-08-16
---

# Documentation policy

This policy applies to every project-authored Markdown file in the repository, not only files under `docs`. Vendored dependencies, generated output, Git internals, and runtime media are excluded.

## Metadata

New or materially revised documents use YAML frontmatter:

```yaml
---
title: Human-readable title
document_type: architecture | decision | specification | design | runbook | research | assessment | plan | playbook | index
status: canonical | draft | accepted | active | reference | review-required | superseded | historical | archived
updated: YYYY-MM-DD
applies_to:
  - full-bare-metal
  - docker-application
  - host-control
supersedes: []
related: []
---
```

Only include `applies_to`, `supersedes`, and `related` when they add information.

## Authority and lifecycle

- A topic has one canonical entry point. Its folder `README.md` identifies it.
- Specifications distinguish implemented behavior from target behavior and link to code or tests as evidence.
- Important architectural choices become numbered ADRs; prose labelled “LOCK” is not a substitute.
- Assessments and audits are dated snapshots. They are not continuously rewritten into pseudo-specifications.
- Superseded documents move to `99-archive` with their content intact and a pointer to the replacement.
- Research records evidence and attribution but does not become product direction until accepted separately.
- Playbooks explain how to create knowledge; they are not sources of product truth.

## Naming

- Use lowercase kebab-case.
- Let directories provide context; do not prefix every filename with `archivist-`.
- Use ISO dates for snapshots, for example `2026-07-assessment.md`.
- Avoid `new`, `latest`, `final`, and version labels in canonical filenames.
- Use `ADR-NNNN-short-description.md` for architecture decisions.
- Keep binary assets under `06-design/assets`.

## Enforcement

Run `pnpm docs:check` to validate every in-scope Markdown file. The repository-wide `pnpm verify` command runs this check first, so missing or unsupported metadata fails verification before build and tests.

## Workflow

1. Capture an unclassified note in `_inbox`.
2. Decide whether it is knowledge, a decision, research, a plan, or history.
3. Reconcile it with the canonical source for that topic.
4. Link it from the nearest folder index.
5. Update its status and review date when implementation changes.
6. Archive superseded material rather than leaving competing truths in active folders.


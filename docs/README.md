---
title: Archivist knowledge base
document_type: index
status: canonical
updated: 2026-08-16
---

# Archivist knowledge base

This repository is the durable product and engineering memory for Archivist. Start here; filenames that sound definitive are not automatically authoritative.

## Authority order

1. Executable code, migrations, contracts, deployment configuration, and tests describe delivered behavior.
2. [`AGENT.md`](../AGENT.md) defines repository workflow and safety rules.
3. [`ARCHIVIST_CORE.md`](../ARCHIVIST_CORE.md) is the high-level system reference.
4. The canonical register below contains implementation-reconciled topic references.
5. Accepted ADRs define agreed direction, which may be ahead of delivery.
6. Drafts/plans are future work; research and historical/archive material are context only.

## Canonical register

| Subject | Source |
|---|---|
| Product purpose, engineering rules, and deep system summary | [`AGENT.md`](../AGENT.md), [`ARCHIVIST_CORE.md`](../ARCHIVIST_CORE.md) |
| Implemented capabilities | [`01-foundation/capability-map.md`](01-foundation/capability-map.md) |
| Terminology and known limits | [`terminology.md`](01-foundation/terminology.md), [`known-limitations.md`](01-foundation/known-limitations.md) |
| Runtime architecture and trust boundaries | [`system-architecture.md`](02-architecture/system-architecture.md) |
| Data ownership and migrations | [`data-model.md`](02-architecture/data/data-model.md) |
| HTTP/API ownership | [`http-api.md`](02-architecture/interfaces/http-api.md) |
| Deployment profiles and delivered operations | [`deployment/`](02-architecture/deployment/README.md), [`deployment-and-configuration.md`](07-operations/deployment-and-configuration.md) |
| Library, Player, Catalogue, Control, Kodi | [`03-products/`](03-products/README.md) |
| Acquisition/RSS/airtime automation | [`acquisition-and-release-monitoring.md`](04-features/acquisition/acquisition-and-release-monitoring.md) |
| Visual language and tokens | [`06-design/design-system.md`](06-design/design-system.md) |
| Documentation governance | [`documentation-policy.md`](01-foundation/documentation-policy.md) |

## Library map

| Area | Purpose | Entry point |
|---|---|---|
| Foundation | Capabilities, vocabulary, limitations, governance | [`01-foundation/`](01-foundation/README.md) |
| Architecture | Runtime, data, interfaces, security, deployment, decisions | [`02-architecture/`](02-architecture/README.md) |
| Products | Application-specific current state and history | [`03-products/`](03-products/README.md) |
| Features | Cross-product feature references and historical specifications | [`04-features/`](04-features/README.md) |
| Media domains | Domain-specific data/design history | [`05-media-domains/`](05-media-domains/README.md) |
| Design | Implemented design system and assets | [`06-design/`](06-design/README.md) |
| Operations | Installation, configuration, recovery, and troubleshooting | [`07-operations/`](07-operations/README.md) |
| Research | External-system analysis; never implementation truth | [`08-research/`](08-research/README.md) |
| Planning | Dated assessments and future plans | [`09-planning/`](09-planning/README.md) |
| Playbooks | Reusable authoring templates | [`10-playbooks/`](10-playbooks/README.md) |
| Inbox | Temporary capture awaiting classification | [`_inbox/`](_inbox/README.md) |
| Archive | Superseded/historical corpora | [`99-archive/`](99-archive/README.md) |

Run `pnpm docs:check` after documentation or implementation changes. It validates metadata, internal links, and code-bound documentation invariants.

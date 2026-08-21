---
title: "Testing and quality gates"
document_type: plan
status: historical
classified: 2026-08-16
---
# Testing and quality gates

## Objective

Prevent the locked design and remote-first behaviour from fragmenting again. Builds passing TypeScript is necessary but not sufficient for a living-room release.

## Test layers

### Contract and unit

- preference migration removes retired visual fields and preserves retained values;
- availability, next-item, journey ordering and relationship validation;
- track language/title/default normalisation;
- card labels and aggregate download percentages;
- playback state transitions and error recovery.

### Component

- canonical server-mirror Home sections and featured-content fallbacks;
- film/series/season/episode detail variants;
- filters, empty/error/loading states;
- media selector, OSD panels and activity cards;
- focus entry, exit and restoration for every drawer/dialog.

### End-to-end

- new profile to playback with no setup;
- continue/resume/complete and watched rollups;
- browse → detail → Back restoration;
- season switching, Show Watched and episode playback;
- journey order switching and Continue Journey;
- direct-play failure to compatibility mode;
- live download becoming available;
- server interruption and recovery.

## Visual regression matrix

Capture deterministic 1080p and 4K baselines for Home, browse, search, each detail entity, journey, downloads, settings and every OSD layer. Each has artwork-rich, missing-art, long-title, localisation-stress, high-contrast and text-scale fixtures. Pair representative server and Player screens to catch token drift.

## Performance and accessibility gates

- automated accessibility scan plus manual remote/screen-reader smoke run;
- focus-order snapshots or explicit navigation assertions;
- bundle-size and route-chunk budgets;
- artwork payload/decode measurements;
- animation/focus latency trace on representative television hardware;
- no console errors or unhandled rejections in core journeys.

## Release discipline

Every Player change identifies affected contract fixtures, focus path, visual baselines and migration impact. A feature is not complete while its server dependency is mocked only in the browser. Rollout of preference/schema changes must be backward compatible for at least the documented support window.

## Acceptance criteria

- CI blocks token drift, broken contract fixtures, focus regression and major visual changes.
- Golden journeys run against a real test server/database, not only mocked SDK calls.
- A release candidate is exercised with remote input on target-class hardware.
- Approved visual changes update baselines with an explicit rationale.

---
title: "Performance, caching and resilience"
document_type: plan
status: historical
classified: 2026-08-16
---
# Performance, caching and resilience

## Objective

Keep the Player fluid on television browsers and low-powered clients while the server, network or artwork provider is imperfect.

## Budgets

Establish measured budgets rather than relying on desktop development hardware:

- cached shell visible promptly after navigation;
- useful Home content within two seconds on a typical local network;
- focus response within one animation frame under normal load;
- route transition without full bootstrap refetch;
- no unbounded artwork decoding or backdrop timers;
- bounded initial JavaScript through route/panel code splitting.

Exact numeric release budgets should be captured from representative target devices before implementation is marked complete.

## Data strategy

- Bootstrap profile, navigation policy, feature flags and initial Home data in one versioned response.
- Cache stable metadata and artwork aggressively with validators.
- Revalidate progress/download state independently from stable item metadata.
- Prefer server events for acquisitions, jobs and watched changes, with periodic reconciliation after disconnect.
- Cancel stale search, hub and detail requests.
- Deduplicate entity data across rows through a client query/cache layer.

## Rendering strategy

- Lazy-load off-screen cards and images.
- Limit simultaneous decoded backdrops; release old object/image references.
- Virtualise genuinely long grids without breaking D-pad focus.
- Reserve image aspect ratios to prevent layout shift.
- Avoid blur filters and large continuously composited layers on low-powered clients.
- Poll only as a fallback; the existing five-second full hub refresh for downloads should become a targeted update.

## Resilience states

The shell should distinguish server unavailable, authentication expired, partial endpoint failure, stale cached content, playback host failure and unsupported media. Retry should be scoped to the failed request. A correlation ID and server timestamp help support without dumping technical logs into the living-room UI.

## Offline expectations

Archivist is local-server software, not an offline streaming product. Cached metadata may keep navigation coherent during a short interruption, but playback availability must be verified. Never show a cached Play button if the stream cannot be reached.

## Acceptance criteria

- Performance is profiled on at least one low-powered target and desktop baseline.
- Home download updates do not refetch or rerender unrelated stable rows.
- Search cancellation and route unmounts produce no stale state commits.
- Partial failures preserve working content.
- Bundle, image and interaction budgets are enforced in CI where practical.

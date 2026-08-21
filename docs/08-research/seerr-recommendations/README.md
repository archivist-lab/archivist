---
title: "Archivist discovery and recommendation engine"
document_type: research
status: historical
classified: 2026-08-16
---
# Archivist discovery and recommendation engine

## Purpose

This package reviews [Seerr](https://github.com/seerr-team/seerr) and specifies an Archivist-native discovery and recommendation system that is at least as dependable for broad discovery and materially better at personal relevance.

The source review covers Seerr commit [`5ae70d05`](https://github.com/seerr-team/seerr/tree/5ae70d05e1ee123b3cda43153ed415754fd8e816), dated 5 July 2026.

This is documentation only. No implementation code was added.

## Central finding

Seerr is a strong discovery and request interface, but it is not itself a personalised recommendation engine. Its recommendation and similar-title endpoints forward TMDB's item-to-item results. Its main Discover page is a configurable sequence of TMDB popular, trending, upcoming, genre, keyword, network, studio and provider feeds, enriched with Seerr's local availability/request records.

Seerr can read recent Plex/Tautulli watch history for a user profile, but that history is displayed on the profile and is not used to rerank TMDB recommendations.

Archivist can therefore exceed Seerr without trying to reproduce a large external recommendation model. It should:

1. preserve Seerr's breadth of candidate generation;
2. add Archivist's authoritative profile progress and completion data;
3. rank candidates with a deterministic, explainable hybrid model;
4. distinguish available, new, acquiring and upcoming titles;
5. learn from completion and explicit feedback rather than clicks alone;
6. precompute durable snapshots so discovery still works when TMDB is unavailable.

The Server application also exposes the ranked findings directly under **Films → Recommendations** and **Series → Recommendations**. These are acquisition-facing views: recommendation cards must use the same clickable detail and Add workflow as the corresponding metadata search results.

## Required product behaviour

The engine should heavily reward titles and series that viewers finish. In-progress titles provide a weaker positive signal. Dormant, repeatedly unfinished titles may become a negative signal, but only after a grace period and confidence checks.

This distinction matters:

- **fully watched** is strong evidence of sustained interest;
- **actively in progress** is weak-to-moderate evidence;
- **recently started** is ambiguous;
- **abandoned** is negative evidence;
- **unstarted** says nothing;
- **unfinished because episodes are missing or unaired** must never be treated as disinterest.

## Documents

- [What Seerr does under the hood](seerr-analysis.md)
- [Recommendation engine specification](engine-specification.md)
- [Ranking, completion weighting and diversity](ranking-model.md)
- [Data contracts, delivery roadmap and acceptance gates](implementation-roadmap.md)
- [Delivered implementation status and validation](implementation-status.md)

## Recommended first release

Build a deterministic content-based hybrid before considering matrix factorisation or embeddings:

- generate candidates from TMDB recommendation/similar/discover feeds and Archivist metadata relationships;
- calculate completion-aware profile and household affinities;
- rank with a documented formula;
- diversify the final rails;
- explain every recommendation;
- expose explicit More Like This, Less Like This and Not Interested controls;
- expose film-only and series-only Recommendations tabs in the Server application;
- reuse the existing search-result detail and acquisition interactions for every recommendation;
- evaluate against future completed viewing, not card clicks.

This works with a single household, avoids the cold-start problem of collaborative filtering and can be audited title by title.

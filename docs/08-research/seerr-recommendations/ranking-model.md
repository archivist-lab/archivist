---
title: "Ranking, completion weighting and diversity"
document_type: research
status: historical
classified: 2026-08-16
---
# Ranking, completion weighting and diversity

## Status

This document defines the version-1 deterministic model. The numbers are initial engineering defaults, not timeless truths. They must be stored under a model-version identifier and adjusted only against measured outcomes.

## Signal hierarchy

From strongest positive to weakest:

1. explicit More Like This or high rating;
2. repeat completion;
3. full completion/caught-up series;
4. watchlist or acquisition request;
5. substantial active progress;
6. detail/trailer engagement;
7. brief start;
8. exposure without interaction.

Negative hierarchy:

1. explicit Not Interested;
2. explicit Less Like This;
3. repeated dormant abandonment;
4. one dormant unfinished item;
5. exposure without interaction.

Unstarted library ownership is neutral.

## Meaningful playback

Ignore accidental opens until either:

- five minutes have been watched; or
- 5% of runtime has been watched.

Playback errors and sessions shorter than the threshold do not train the model.

## Film seed weight

Let:

- `r` be credible watched proportion from 0 to 1;
- `completed` be the server completion state;
- `active` mean activity within the last 30 days;
- `dormant` mean no activity for at least 30 days.

Initial implicit weight:

| State | Seed weight |
|---|---:|
| Completed | `1.00` |
| Completed more than once | `1.00 + min(0.30, 0.10 × extra completions)` |
| Active, incomplete | `0.45 × r²` |
| Dormant, at least 80% watched | `0.20` |
| Dormant, 5–80% watched | `-0.35 × (1 - r)` |
| Below meaningful threshold | `0` |

This creates a deliberate completion jump. A film at 50% contributes `0.1125`; completion contributes `1.0`.

If Archivist currently stores only the latest position, version 1 can operate without repeat completion. A playback-event table is needed before replay strength can be reliable.

## Series seed weight

Calculate against eligible episodes only.

Let:

- `c = completed eligible episodes / eligible episodes`;
- `caughtUp` mean all eligible episodes are complete;
- `active` mean an eligible episode was watched within 45 days;
- `dormant` mean no activity for at least 45 days.

| State | Seed weight |
|---|---:|
| Caught up/completed | `1.25` |
| Active, incomplete | `0.55 × c²` |
| Dormant, at least 80% complete | `0.30` |
| Dormant, below 80% complete | `-0.50 × (1 - c) × confidence` |

`confidence` rises from 0 to 1 as meaningful eligible viewing approaches three episodes. One unfinished pilot should not strongly poison an entire series affinity.

The denominator excludes unaired, unavailable, inaccessible and policy-excluded episodes. A currently caught-up continuing show remains a strong positive seed.

## Explicit-signal overrides

| Event | Value |
|---|---:|
| More Like This | `+1.50` |
| Rating 5/5 equivalent | `+1.50` |
| Rating 4/5 equivalent | `+1.10` |
| Added/monitor requested | `+0.80` |
| Added to watchlist | `+0.70` |
| Already Seen | completion value |
| Less Like This | `-1.00` on item features |
| Not Interested | hard item exclusion plus `-1.25` feature signal |

Explicit negative feedback decays slowly but should remain reversible from profile settings.

## Recency

Completed viewing should not disappear quickly. Apply a half-life to seed influence:

- first 180 days: no decay;
- thereafter: 730-day half-life;
- explicit favourites: no decay unless removed;
- abandonment: 365-day half-life.

This allows tastes to evolve without erasing long-term identity.

## Household aggregation

Each profile contributes at most one normalised signal per title, so one frequent viewer cannot dominate merely by replay count.

For item `i`:

`household(i) = weighted_mean(profile_seed(i), profile_reliability)`

Profile reliability depends on the amount of meaningful history, capped so experienced profiles do not silence newer ones.

Negative household evidence uses Bayesian shrinkage. It should not activate until:

- at least three eligible profiles started the item; or
- an administrator explicitly permits small-household negative aggregation.

This prevents two people pausing a film from turning it into a universal dislike signal.

## Affinity vector

For each profile and household, aggregate seed weights into feature affinities.

`affinity(feature) = Σ(seed_weight × item_feature_weight × IDF(feature))`

IDF reduces the value of ubiquitous features:

`IDF(f) = log((N + 1) / (items_with_f + 1)) + 1`

Suggested feature importance before IDF:

| Feature | Weight |
|---|---:|
| Continuity/universe | 1.00 |
| Collection/franchise | 0.95 |
| Keyword/theme | 0.85 |
| Director/creator | 0.80 |
| Genre | 0.65 |
| Principal cast | 0.45 |
| Network/studio | 0.40 |
| Original language/country | 0.30 |
| Era | 0.20 |
| Runtime band | 0.10 |

Normalise each affinity vector so library size does not inflate scores.

## Candidate similarity

Calculate local similarity as weighted cosine similarity between the candidate feature vector and the profile/household affinity vector.

Use TMDB recommendation/similar rank as a separate signal:

`provider_rank_score = 1 / log2(rank + 1)`

If several completed seeds nominate one candidate, combine the strongest three contributions with diminishing returns. Do not let one enormous franchise dominate by raw nomination count.

## Public-quality confidence

Use a Bayesian-adjusted public rating rather than raw average:

`quality = (v / (v + m)) × R + (m / (v + m)) × C`

Where:

- `R` is title rating;
- `v` is vote count;
- `C` is the media-type mean;
- `m` is the minimum confidence vote count.

Public quality is a guardrail and tie-breaker, not a substitute for taste.

## Version-1 relevance score

For a mature profile:

`relevance =`

- `0.40 × profile_affinity`
- `0.16 × household_affinity`
- `0.12 × provider_rank`
- `0.08 × public_quality`
- `0.08 × freshness_or_release_fit`
- `0.07 × novelty`
- `0.05 × curator_signal`
- `0.04 × exploration`
- penalties.

Penalties include:

- explicit rejection;
- already completed, unless the surface allows rewatches;
- dormant-abandonment feature match;
- repeated exposure;
- unavailable state on an available-only surface;
- blocked certification/content;
- duplicate/franchise saturation.

For new profiles, reduce profile affinity and redistribute weight primarily to household affinity, public-quality confidence and diversified popularity. Blend toward the mature formula as meaningful seeds accumulate.

Weights should be surface-specific:

- **In your museum** increases availability and local novelty;
- **New discoveries** increases provider and public-quality confidence;
- **Upcoming for you** increases release fit and date confidence;
- **Because you finished** increases seed-specific affinity.

## Incomplete aggregate interpretation

The requested principle—unfinished content generally signals less interest in aggregate—is implemented through three safeguards:

1. unfinished active content is a weak positive, not a negative;
2. unfinished dormant content is negative only after a grace period;
3. household negative evidence is shrunk until several independent starts exist.

This preserves the aggregate insight without teaching the engine that long-running, unavailable or recently started series are disliked.

## Diversity reranking

After relevance scoring, use maximal marginal relevance:

`MMR(candidate) = λ × relevance - (1 - λ) × max_similarity(candidate, selected)`

Start with `λ = 0.78`.

Apply hard rail constraints:

- no more than two titles from one franchise/continuity;
- no more than three titles with the same dominant genre;
- no adjacent cards with the same primary explanation seed;
- one title appears only once per page unless explicitly repeated in a status rail;
- upcoming, external and available states remain separated unless the rail says otherwise.

Reference: [The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries](https://doi.org/10.1145/290941.291025).

## Exploration

Use deterministic exploration rather than pure randomness:

- daily seed from profile ID, model version and date;
- candidates must meet safety and minimum-quality thresholds;
- do not explore titles recently rejected or repeatedly exposed;
- log exploration separately for evaluation.

Ten percent is an upper starting bound, not a target that must always be filled.

## Exposure and feedback learning

Record an exposure only when a card is actually rendered in the viewport long enough to be perceivable.

Do not treat a single ignored exposure as dislike. Suggested penalty:

- first two ignored exposures: zero;
- third to fifth: small presentation penalty;
- later repeats: suppress for 60 days.

If the profile opens details, starts, meaningfully watches, completes, dismisses or adds the title, join that outcome back to the exposure and model version.

## Evaluation

### Offline temporal evaluation

For each profile:

1. train on events before timestamp `T`;
2. generate candidates using only information available at `T`;
3. test whether later meaningfully started/completed titles rank highly.

Never use random train/test splits that leak future viewing into the past.

Primary metrics:

- NDCG@10 for later completed titles;
- Recall@10 for later meaningful starts;
- mean reciprocal rank;
- catalogue coverage;
- intra-list diversity;
- novelty;
- genre/language calibration;
- explanation coverage.

### Online outcome metrics

- meaningful-start rate;
- completion/caught-up rate;
- add-to-library to meaningful-start conversion;
- Not Interested and Less Like This rate;
- repeated-exposure rate;
- time from recommendation to play;
- percentage served from fresh or stale snapshot;
- external-source failure rate.

Clicks and detail opens are diagnostics, not the primary success metric.

### Guardrails

A new model must not:

- reduce available-item completion;
- increase repeated rejected recommendations;
- collapse catalogue coverage;
- overconcentrate on one genre/franchise;
- produce unexplained results;
- increase Home latency.

## Later machine-learning options

Only after enough event data exists:

- implicit-feedback alternating least squares for profile/item latent factors;
- Bayesian personalised ranking for pairwise ordering;
- a learning-to-rank model over the documented features;
- local metadata embeddings for synopsis/theme similarity.

Small private servers are sparse, so collaborative models must remain a supplemental signal with content-based fallback.

Background references:

- [Collaborative Filtering for Implicit Feedback Datasets](https://doi.org/10.1109/ICDM.2008.22)
- [BPR: Bayesian Personalized Ranking from Implicit Feedback](https://doi.org/10.48550/arXiv.1205.2618)


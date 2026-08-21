---
title: "Film, series, season, episode and person experiences"
document_type: plan
status: historical
classified: 2026-08-16
---
# Film, series, season, episode and person experiences

## Objective

Rebuild item pages as playback-facing mirrors of the server item pages. The current Player has many necessary capabilities—editions, people, season selection, episode dialogs, stream selection and recommendations—but wraps them in a separate hero, dock, button and section language.

## Shared exhibit shell

Every detail surface starts with the server `DetailPage`, `DetailHeader`, `DetailPoster`, `DetailMain`, `DetailStoryline` and `DetailMetaItem` composition. It uses:

- the same backdrop dimensions, opacity, blur and scrims;
- the same poster dimensions, radius, border and placement;
- Bebas Neue wherever the equivalent server entity/display heading uses it;
- JetBrains Mono for the same metadata/status roles used by the server;
- Play/Resume in the server action region where scan/acquire actions would otherwise appear;
- the same synopsis width, section spacing and secondary-detail treatment;
- server modal/drawer surfaces for technical or secondary actions;
- relationship sections built from shared cards and headings;
- focus restoration to the invoking control.

The current Player `DetailHero`, `DetailDock`, rounded-pill `DetailAction` and oversized sans headings are migration sources, not the target visual specification.

No item page should require configuration of action order, rating slots or detail rows. The product determines the hierarchy.

## Films

- Show year, certification, runtime, genres and primary rating before file details.
- Make edition selection explicit before playback when multiple playable editions exist; clearly mark the server default.
- Place audio/subtitle selection in the pre-play media surface and carry it reliably into playback.
- Present collection/journey position (“3 of 5”) and next/previous related works.
- Keep trailer, watched toggle, metadata refresh status and file details in a consistent secondary action surface.
- Recommendations must distinguish collection, shared universe, same director/people and algorithmic similarity.

## Series

- Do not show a large season poster as a separate hero.
- Keep a compact season switcher beneath series identity.
- Selecting a season updates the episode section in place without losing focus.
- Hide watched episodes by default; Show Watched is a persistent profile behaviour only if product research supports persistence, otherwise it resets per visit.
- Surface next playable episode and series-level progress near the primary action.

## Seasons

- Season artwork may appear as a supporting thumbnail/card, not a dominant second poster.
- Show season synopsis, year/air range, episode count, watched count and availability.
- Season relationships and specials placement follow server ordering.
- Mark season watched/unwatched is secondary and must clearly describe its effect.

## Episodes

- An episode selection opens the same rich information model whether launched from Calendar, Series or Search.
- Show series title, `SxxExx`, episode title, local air date/time, runtime, synopsis, still, progress and availability.
- Provide Play/Resume, automatic/manual user-driven scan where the current product permits acquisition controls, watched toggle and metadata edit/refresh in an ordered action group. Automated monitoring policy remains server administration.
- Pre-play audio and subtitle selection uses the actual default stream as selected; never show an artificial “Automatic” track.
- Previous/next navigation skips unavailable episodes only when starting playback, not when exploring metadata.

## People

- Show portrait, biography, known-for context and only library-linked filmography by default.
- Separate roles (actor, director, writer, creator) and avoid duplicate works.
- A person page is a discovery route, not an external encyclopaedia.

## Acceptance criteria

- Primary content and action fit within the first television viewport at 1080p.
- Film and episode stream selections are honoured by the player.
- Series season switching and Show Watched never reset the page or focus unexpectedly.
- Calendar and series episode dialogs expose equivalent information and actions.
- All entity surfaces have artwork-missing, unavailable, partial and error fixtures.

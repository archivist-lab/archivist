---
title: "Vision and principles"
document_type: plan
status: historical
classified: 2026-08-16
---
# Vision and principles

## North star

Archivist is a private museum for a media collection. The server acquires, catalogues, restores and curates. The Player opens the doors.

The Player should feel like Archivist immediately, without configuration: the server interface translated from collection management to playback. It should reveal that two works share a collection, universe, continuity, creator, character or historical context without turning browsing into a metadata spreadsheet.

## Experience principles

### Curated by the server

The server supplies exhibit order, featured groups, relationships, availability and preferred artwork. The Player does not ask every profile to rebuild that structure. Personal state may affect ranking—continue watching, watched items, recommendations—but not the institution’s visual identity.

### One coherent language

There is one Archivist shell, palette, type-role system, icon family, spacing scale, radius scale, border treatment, card grammar and motion language. The server is the visual source of truth. The Player may enlarge focus targets and safe areas where a remote or viewing distance requires it, but must not invent a second composition language. Content-type colours retain meaning across both.

### The interface leads consistently

Artwork, titles, metadata, sections and actions follow the same hierarchy used by the corresponding server surface. Player-only information such as progress, editions and tracks is inserted into that hierarchy using existing Archivist primitives. Codec, stream and file data live one deliberate layer deeper.

### Relationships are journeys

A collection is not just a label. A viewer can move through chronology, release order, continuity, spin-offs, adaptations and related exhibits. Every relationship must explain itself; “Related” should never be an unexplained recommendation bucket.

### Available by default

The general Player presents media that can be played. Wanted, acquiring and upgrading items appear only in explicit download/acquisition contexts. A failed or missing file never masquerades as playable.

### Remote first, pointer complete

Every interaction has a deterministic D-pad path, visible focus, stable Back behaviour and focus restoration. Pointer and touch remain supported, but television use defines layout and target sizing.

### Progressive disclosure

The first screen answers “what is this?” and “can I play it?” The next layer answers “where does it fit?” A further layer answers “what file and streams are available?” This prevents technical richness becoming visual noise.

### Honest state

Loading, unavailable, transcoding, acquiring, failed, partially watched and watched are different states and must look and read differently. The Player should never silently substitute an empty rail, wrong edition or default stream.

### Durable simplicity

Remove settings whose only purpose is to compensate for an unsettled design. Keep settings needed for accessibility, identity and playback. Prefer a small number of well-tested compositions over combinatorial UI variants.

## In scope

- Films, series, seasons, episodes, people, collections and relationship journeys.
- Home, library, search, details, playback, downloads and Channels.
- Server-side curation and the read contracts needed by the Player.
- Responsive television/desktop layouts, keyboard/gamepad navigation and accessibility.
- Visual, interaction, performance and regression standards.

## Non-goals for this programme

- A skin or theme marketplace.
- User-authored CSS, arbitrary colours or per-device layout design.
- Reproducing Kodi add-ons or native hardware control in a browser.
- Exposing server administration, indexer control or acquisition policy editing in the Player.
- Hiding accessibility controls in the name of visual consistency.

## Product vocabulary

- **Exhibit:** a playable or contextual media entity shown in the Player.
- **Curator:** server-side configuration and metadata that shape presentation.
- **Journey:** an ordered set of related exhibits, such as a continuity or collection.
- **Available:** a verified playable file/edition exists.
- **Acquiring:** accepted download work exists but is not ready to play.
- **Conservation:** background media processing such as encoding, normalisation or track cleaning.

These terms may support copy and architecture, but familiar labels such as Films, Series, Seasons and Episodes should remain in primary navigation.

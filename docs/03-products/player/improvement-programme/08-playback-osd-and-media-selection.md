---
title: "Playback, OSD and media selection"
document_type: plan
status: historical
classified: 2026-08-16
---
# Playback, OSD and media selection

## Objective

Make playback feel dependable and quiet. The first OSD layer should answer only what is playing, where the viewer is and how to pause/seek/stop. Stream, chapter and compatibility controls belong in clearly labelled secondary panels.

## Pre-play media selection

- The actual server-selected default audio and subtitle tracks are highlighted; there is no synthetic Automatic option.
- Audio rows show flag, Title Case title, then channels and codec two typographic steps smaller, separated by ` ㆍ `.
- Subtitle rows show flag and Title Case title.
- Language derives from the same tags and normalisation used by the server media-track UI, with ISO-code and filename fallbacks.
- Commentary, descriptive audio, forced, SDH/HI, default and original-language flags are visible but not noisy.
- Selection is scoped to the item unless the viewer explicitly changes a profile language preference.

## OSD hierarchy

### Primary layer

- title and episode identity;
- play/pause;
- timeline with chapter/segment markers;
- elapsed/remaining time;
- back/stop;
- current audio/subtitle state.

### Secondary panels

- audio and subtitles;
- subtitle search/download and delay;
- audio delay and playback speed;
- chapters and bookmarks;
- episode queue/Up Next;
- playback information (direct/transcode, codec, container, resolution and processing reason).

## Playback state machine

Document and test states for loading, resume prompt, direct play, compatibility fallback, seeking transcode, buffering, paused, segment skip, Up Next, Still Watching, post-play recommendation, minimised and fatal error. Transitions should be explicit rather than distributed timers.

Direct-play failure may fall back once to compatibility playback at the preserved position. Repeated failure presents a clear message and correlation identifier. Changing audio during direct play may require compatibility mode; the Player must explain this without alarming the viewer.

## Segments and Up Next

- Skip Intro/Credits appears only inside a valid marker window.
- Automatic skipping respects retained playback preferences and confidence thresholds.
- Up Next does not compete with a credits-skip action.
- Automatic advance applies only to eligible series episodes, with countdown, cancel and failed-next handling.
- Films use post-play recommendations, never an unexplained episode-style advance.

## Accessibility

Controls have names independent of icons, focus never disappears with the OSD timer, subtitle controls remain reachable without precision input and reduced motion removes large transitions. OSD contrast is validated over bright and dark fixtures.

## Acceptance criteria

- Item-level stream choices are applied on first playback request.
- Default tracks are correct and understandable before playback.
- All OSD functions are reachable by remote and keyboard without pointer hover.
- Position survives direct-to-compatibility fallback and minimisation.
- Playback state-machine, Up Next, segment and track-selection paths have automated tests.

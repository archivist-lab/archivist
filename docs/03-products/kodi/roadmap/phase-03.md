---
title: "Kodi media add-on — Phase 3"
document_type: plan
status: historical
classified: 2026-08-16
---
# Kodi media add-on — Phase 3

## Outcome

Phase 3 turns the Kodi integration from a library mirror with direct playback into an intelligent Archivist playback client. Kodi continues to own rendering and its native OSD; Archivist supplies the playback decision, editions, preferred tracks, intro/credit segments, secure credentials and synchronization state.

## Playback negotiation

The add-on probes each item through the existing Player track API and describes the Kodi device through explicit capability settings. It selects the preferred audio and subtitle tracks, then chooses direct play when the selected video, audio and maximum resolution are compatible. Otherwise it uses Archivist's H.264/AAC compatibility transcode. A failed direct-play attempt is retried once through the transcode route.

The selected mode and reason are retained as playback diagnostics. Capability settings are deliberately explicit and conservative because Kodi exposes no single reliable cross-platform codec-capability API.

## Editions and tracks

Films with more than one available edition present a pre-play selector containing edition name, runtime and quality. The chosen edition is streamed without changing the library-wide default. Preferred audio language, subtitle language and subtitle mode are applied before playback; Kodi's OSD remains available for later changes.

## Segments

Episode track responses already contain Archivist intro and credit segments. The Kodi service treats these independently from embedded chapters. It can prompt to skip intros and credits or automatically skip credits, depending on settings. Missing, queued or low-confidence analysis never prevents playback.

## Resilience and diagnostics

The background service records its most recent successful library sync, failure, retry time and error. Automatic synchronization uses bounded exponential backoff after failures. A repair action discards only Archivist's managed synchronization state and rebuilds the mirror; unrelated Kodi sources and files remain untouched.

## Security

Normal username/password setup exchanges the short-lived login session for a named, revocable Kodi device credential. The password is never persisted. Existing session-cookie and service-token installations remain compatible during migration.

## Acceptance criteria

- Compatible files direct-play and incompatible files use the compatibility transcode.
- A direct-play startup error is retried once through the transcode path.
- Preferred audio and subtitle streams are selected without removing Kodi OSD control.
- A non-default film edition can play without changing the server default.
- Intro and credit prompts use Archivist segments and do not alter chapters.
- Sync failures back off, remain visible in diagnostics and recover automatically.
- Device credentials are individually identifiable and revocable.
- The managed native library remains the only filesystem tree the add-on mutates.

# -*- coding: utf-8 -*-
"""New and redesigned Archivist icon geometry.

Every body follows the pack contract: 64x64 grid, stroke-width="3",
`currentColor`, round caps/joins, optional solid accent marks.
Secondary detail strokes use stroke-width="2" and are scaled to 0.66x
of the primary weight by the TSX emitter.
"""

G = '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
GJ = '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round">'
GC = '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">'

# ---------------------------------------------------------------------------
# Redesigns: these five names shipped in the 18-08 set with geometry cloned
# from another icon. Each now carries its own drawing.
# ---------------------------------------------------------------------------
REDESIGNS = {
    'expand-right': (
        'Actions',
        GJ + '<path d="M25 13l21 19-21 19z"/></g>',
        'Was a clone of chevron-right. File-tree disclosure reads better as a '
        'triangle so it never competes with navigational chevrons.',
    ),
    'auto-grab': (
        'Actions',
        G + '<path d="M35 7L17 33h11l-2 15 18-24H32z"/><path d="M12 55h40"/></g>',
        'Was a clone of bolt. Now a bolt landing on a floor line: an automatic '
        'grab that completes into the library.',
    ),
    'quick-action': (
        'Actions',
        G + '<circle cx="32" cy="32" r="24"/><path d="M35 15L23 34h9l-3 15 12-19h-9z"/></g>',
        'Was a clone of bolt. Now a contained bolt, matching the circular '
        'affordance of an accelerated one-tap action.',
    ),
    'featured': (
        'Status',
        GJ + '<path d="M32 6l7 19 19 7-19 7-7 19-7-19-19-7 19-7z"/></g>',
        'Was a clone of sparkle. Featured is now one dominant four-point star; '
        'sparkle keeps the two-star cluster for generated/AI surfaces.',
    ),
    'platform-pc-steam': (
        'Platforms',
        G + '<rect x="7" y="11" width="50" height="32" rx="4"/>'
            '<path d="M21 55h22l-3-12H24z"/><path d="M17 55h30"/>'
            '<circle cx="32" cy="27" r="7"/></g>'
            '<circle cx="32" cy="27" r="2.6" fill="currentColor"/>',
        'Was a clone of platform-pc. The valve disc separates a storefront '
        'library from a bare PC platform.',
    ),
    'award-academy': (
        'Awards',
        G + '<circle cx="32" cy="12" r="6.5"/><path d="M25.5 19h13l-2 22h-9z"/>'
            '<path d="M23 41h18v6H23z"/><path d="M18 47h28v9H18z"/></g>',
        'Was a clone of award. Now a statuette on a plinth, so the generic '
        'trophy stays available for any unnamed award.',
    ),
    'music': (
        'Modules',
        G + '<circle cx="17" cy="45" r="7"/><circle cx="45" cy="41" r="7"/>'
            '<path d="M24 45V15M52 41V11"/><path d="M24 15l28-4v9l-28 4z"/></g>',
        'Was a cassette shell, which read as a format rather than as music. Now '
        'a beamed pair of quavers — the mark the domain actually wants.',
    ),
    'upcoming': (
        'Status',
        G + '<rect x="8" y="14" width="48" height="42" rx="4"/>'
            '<path d="M8 27h48M21 8v11M43 8v11"/>'
            '<path d="M24 42h14M33 36l6 6-6 6"/></g>',
        'A dated future release, distinct from pending (a clock face) which '
        'means work in flight.',
    ),
}

# ---------------------------------------------------------------------------
# New icons, grouped as they will appear in the sprite.
# ---------------------------------------------------------------------------
NEW = {
    # --- Modules ------------------------------------------------------------
    'artist': (
        'Modules',
        G + '<rect x="24" y="6" width="16" height="30" rx="8"/>'
            '<path d="M14 29a18 18 0 0036 0"/>'
            '<path d="M32 47v9M22 56h20"/></g>',
    ),
    'song': (
        'Modules',
        G + '<circle cx="22" cy="46" r="8"/><path d="M30 46V12"/>'
            '<path d="M30 12c10 3 16 8 16 15 0 3-1 5-3 7"/></g>',
    ),

    # --- Navigation and product surfaces -----------------------------------
    'leaving-soon': (
        'Navigation',
        G + '<path d="M17 7h30M17 57h30"/>'
            '<path d="M21 7v9c0 7 11 11 11 16s-11 9-11 16v9"/>'
            '<path d="M43 7v9c0 7-11 11-11 16s11 9 11 16v9"/></g>'
            '<path d="M32 36c-3.5 2.5-7 5.5-7 8.5V53h14v-8.5c0-3-3.5-6-7-8.5z" fill="currentColor"/>',
    ),
    'collections': (
        'Navigation',
        G + '<rect x="24" y="8" width="31" height="41" rx="4"/>'
            '<path d="M17 15v33a5 5 0 005 5h24"/>'
            '<path d="M10 22v29a6 6 0 006 6h22"/></g>',
    ),
    'libraries': (
        'Navigation',
        G + '<path d="M8 22a4 4 0 014-4h10l5 7h17a4 4 0 014 4v20a4 4 0 01-4 4H12a4 4 0 01-4-4z"/>'
            '<path d="M56 27v23a6 6 0 01-6 6H19"/></g>',
    ),
    'definitions': (
        'Navigation',
        G + '<path d="M9 47L47 9l8 8L17 55z"/>'
            '<path d="M20 32l5 5M29 23l5 5M38 14l5 5"/></g>',
    ),
    'system': (
        'Navigation',
        G + '<rect x="6" y="10" width="52" height="34" rx="4"/>'
            '<path d="M24 55h16M32 44v11"/><path d="M17 22h13M17 31h21"/></g>',
    ),
    'processing': (
        'Navigation',
        G + '<rect x="7" y="13" width="50" height="38" rx="4"/>'
            '<path d="M23 25h13a7 7 0 010 14H27"/><path d="M32 34l-5 5 5 5"/></g>',
    ),
    'torrents': (
        'Navigation',
        GC + '<circle cx="32" cy="32" r="7.5"/><circle cx="12" cy="13" r="5"/>'
             '<circle cx="52" cy="13" r="5"/><circle cx="12" cy="51" r="5"/>'
             '<circle cx="52" cy="51" r="5"/>'
             '<path d="M16.6 16.6l10.2 10M47.4 16.6L37.2 26.6M16.6 47.4l10.2-10M47.4 47.4L37.2 37.4"/></g>',
    ),
    'catalogue': (
        'Navigation',
        G + '<rect x="7" y="11" width="50" height="42" rx="4"/>'
            '<path d="M7 32h50"/><path d="M26 21h12M26 43h12"/></g>',
    ),
    'control': (
        'Navigation',
        G + '<path d="M8 44a24 24 0 1148 0"/><path d="M32 44l14-14"/></g>'
            '<circle cx="32" cy="44" r="4" fill="currentColor"/>',
    ),
    'people': (
        'Navigation',
        G + '<circle cx="24" cy="21" r="10"/><path d="M6 53a18 18 0 0136 0"/>'
            '<path d="M44 13a10 10 0 010 19"/><path d="M48 37a18 18 0 0110 16"/></g>',
    ),
    'flows': (
        'Navigation',
        G + '<rect x="6" y="9" width="19" height="15" rx="4"/>'
            '<rect x="39" y="9" width="19" height="15" rx="4"/>'
            '<rect x="22.5" y="41" width="19" height="15" rx="4"/>'
            '<path d="M15.5 24v9h33v-9M32 33v8"/></g>',
    ),
    'archivist-mark': (
        'Player marks',
        G + '<rect x="9" y="9" width="46" height="46" rx="7"/>'
            '<path d="M19 22h26M19 32h26M19 42h15"/></g>'
            '<circle cx="45" cy="42" r="3.2" fill="currentColor"/>',
    ),

    # --- Control cockpit ----------------------------------------------------
    'performance': (
        'Infrastructure',
        G + '<path d="M6 44l11-15 8 9 11-23 8 17 6-9h8"/><path d="M6 56h52"/></g>',
    ),
    'services': (
        'Infrastructure',
        G + '<rect x="8" y="9" width="48" height="14" rx="4"/>'
            '<rect x="8" y="27" width="48" height="14" rx="4"/>'
            '<rect x="8" y="45" width="48" height="12" rx="4"/></g>'
            '<circle cx="19" cy="16" r="2.6" fill="currentColor"/>'
            '<circle cx="19" cy="34" r="2.6" fill="currentColor"/>'
            '<circle cx="19" cy="51" r="2.6" fill="currentColor"/>',
    ),
    'recovery': (
        'Infrastructure',
        G + '<path d="M10 32a22 22 0 108-17"/><path d="M8 8v14h14"/>'
            '<path d="M24 33l6 6 12-14"/></g>',
    ),
    'journal': (
        'Infrastructure',
        G + '<rect x="8" y="9" width="48" height="46" rx="4"/>'
            '<path d="M25 22h22M25 32h22M25 42h14"/></g>'
            '<circle cx="17.5" cy="22" r="2.4" fill="currentColor"/>'
            '<circle cx="17.5" cy="32" r="2.4" fill="currentColor"/>'
            '<circle cx="17.5" cy="42" r="2.4" fill="currentColor"/>',
    ),
    'capabilities': (
        'Infrastructure',
        G + '<rect x="8" y="8" width="20" height="20" rx="4"/>'
            '<rect x="36" y="8" width="20" height="20" rx="4"/>'
            '<rect x="8" y="36" width="20" height="20" rx="4"/>'
            '<path d="M37 46l6 6 13-15"/></g>',
    ),
    'files': (
        'Infrastructure',
        G + '<path d="M14 8h20l16 16v32a4 4 0 01-4 4H14a4 4 0 01-4-4V12a4 4 0 014-4z"/>'
            '<path d="M34 8v16h16"/></g>',
    ),
    'folder-up': (
        'Infrastructure',
        G + '<path d="M8 18a4 4 0 014-4h11l6 8h23a4 4 0 014 4v20a4 4 0 01-4 4H12a4 4 0 01-4-4z"/>'
            '<path d="M32 47V32M26 38l6-6 6 6"/></g>',
    ),

    # --- Library status and discovery --------------------------------------
    'collected': (
        'Status',
        G + '<rect x="8" y="13" width="48" height="14" rx="3"/>'
            '<path d="M12 27v23a4 4 0 004 4h32a4 4 0 004-4V27"/>'
            '<path d="M23 39l6 6 12-13"/></g>',
    ),
    'missing': (
        'Status',
        '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" '
        'stroke-dasharray="5 7"><circle cx="32" cy="32" r="23"/></g>',
    ),
    'continuing': (
        'Status',
        G + '<path d="M22 21c-7.2 0-13 4.9-13 11s5.8 11 13 11c11 0 9-22 20-22 7.2 0 13 4.9 13 11'
            's-5.8 11-13 11c-11 0-9-22-20-22z"/></g>',
    ),
    'ended': (
        'Status',
        G + '<path d="M14 8v49"/><path d="M14 12h33l-8 11 8 11H14z"/></g>',
    ),
    'in-cinemas': (
        'Status',
        G + '<path d="M6 12h52v27H6z"/>'
            '<path d="M6 12c8.5 6 17 9 26 9s17.5-3 26-9"/>'
            '<path d="M18 39v16M46 39v16"/></g>',
    ),
    'at-home': (
        'Status',
        G + '<path d="M7 29L32 8l25 21"/>'
            '<path d="M14 26v27a3 3 0 003 3h30a3 3 0 003-3V26"/>'
            '<path d="M27 34l13 8-13 8z"/></g>',
    ),
    'trending': (
        'Status',
        G + '<path d="M8 46l16-16 10 10 22-22"/><path d="M42 18h14v14"/></g>',
    ),

    # --- Media processing pipeline -----------------------------------------
    'loudness': (
        'Playback',
        G + '<path d="M6 24h9l12-10v36L15 40H6z"/><path d="M36 21v22M45 26v12M54 29v6"/></g>',
    ),
    'volume': (
        'Playback',
        G + '<path d="M6 24h9l12-10v36L15 40H6z"/>'
            '<path d="M37 25a10 10 0 010 14"/><path d="M45 17a21 21 0 010 30"/></g>',
    ),
    'volume-muted': (
        'Playback',
        G + '<path d="M6 24h9l12-10v36L15 40H6z"/><path d="M39 25l16 14M55 25L39 39"/></g>',
    ),
    'track-cleaning': (
        'Playback',
        G + '<path d="M8 19h28M8 32h20M8 45h25"/>'
            '<path d="M48 12l3.5 9.5L61 25l-9.5 3.5L48 38l-3.5-9.5L35 25l9.5-3.5z"/></g>',
    ),
    'segments': (
        'Playback',
        G + '<rect x="6" y="25" width="52" height="16" rx="4"/><path d="M21 25v16M43 25v16"/></g>'
            '<circle cx="21" cy="16" r="3.2" fill="currentColor"/>'
            '<circle cx="43" cy="16" r="3.2" fill="currentColor"/>',
    ),
    'chapters': (
        'Playback',
        G + '<path d="M16 8h32a2 2 0 012 2v46L32 44 14 56V10a2 2 0 012-2z"/></g>',
    ),
    'subtitles': (
        'Playback',
        G + '<path d="M12 12h40a4 4 0 014 4v22a4 4 0 01-4 4H28L14 54V42h-2a4 4 0 01-4-4V16a4 4 0 014-4z"/>'
            '<path d="M20 23h24M20 33h14"/></g>',
    ),
    'lyrics': (
        'Playback',
        G + '<path d="M8 19h26M8 31h20M8 43h14"/>'
            '<circle cx="40" cy="43" r="6"/>'
            '<path d="M46 43V13l12 4"/></g>',
    ),
    'headphones': (
        'Playback',
        G + '<path d="M12 41V32a20 20 0 0140 0v9"/>'
            '<rect x="6" y="37" width="12" height="18" rx="5"/>'
            '<rect x="46" y="37" width="12" height="18" rx="5"/></g>',
    ),
    'skip-next': (
        'Playback',
        GJ + '<path d="M16 13l25 19-25 19z"/><path d="M48 12v40"/></g>',
    ),
    'skip-previous': (
        'Playback',
        GJ + '<path d="M48 13L23 32l25 19z"/><path d="M16 12v40"/></g>',
    ),
    'fullscreen': (
        'Playback',
        G + '<path d="M24 8H12a4 4 0 00-4 4v12M40 8h12a4 4 0 014 4v12'
            'M24 56H12a4 4 0 01-4-4V40M40 56h12a4 4 0 004-4V40"/></g>',
    ),
    'fullscreen-exit': (
        'Playback',
        G + '<path d="M8 24h12a4 4 0 004-4V8M56 24H44a4 4 0 01-4-4V8'
            'M8 40h12a4 4 0 014 4v12M56 40H44a4 4 0 00-4 4v12"/></g>',
    ),
    'cast': (
        'Playback',
        G + '<path d="M8 22v-6a4 4 0 014-4h40a4 4 0 014 4v32a4 4 0 01-4 4H36"/>'
            '<path d="M8 32a20 20 0 0120 20M8 43a9 9 0 019 9"/></g>'
            '<circle cx="9.5" cy="52.5" r="3.4" fill="currentColor"/>',
    ),

    # --- Actions ------------------------------------------------------------
    'import': (
        'Actions',
        G + '<path d="M36 32H12"/><path d="M26 22l10 10-10 10"/>'
            '<path d="M40 10h10a6 6 0 016 6v32a6 6 0 01-6 6H40"/></g>',
    ),
    'logout': (
        'Actions',
        G + '<path d="M28 32h24"/><path d="M42 22l10 10-10 10"/>'
            '<path d="M28 12H16a6 6 0 00-6 6v28a6 6 0 006 6h12"/></g>',
    ),
    'scan': (
        'Actions',
        G + '<path d="M10 22V14a4 4 0 014-4h8M42 10h8a4 4 0 014 4v8'
            'M54 42v8a4 4 0 01-4 4h-8M22 54h-8a4 4 0 01-4-4v-8"/>'
            '<circle cx="30" cy="30" r="9"/><path d="M36.5 36.5L45 45"/></g>',
    ),
    'minus': (
        'Actions',
        GC + '<path d="M14 32h36"/></g>',
    ),
    'undo': (
        'Actions',
        G + '<path d="M12 32a21 21 0 106-14.8"/><path d="M10 8v13h13"/></g>',
    ),
    'more': (
        'Actions',
        '<circle cx="32" cy="13" r="4.6" fill="currentColor"/>'
        '<circle cx="32" cy="32" r="4.6" fill="currentColor"/>'
        '<circle cx="32" cy="51" r="4.6" fill="currentColor"/>',
    ),
    'menu': (
        'Actions',
        GC + '<path d="M9 18h46M9 32h46M9 46h46"/></g>',
    ),
    'link': (
        'Actions',
        G + '<path d="M26 38L38 26"/>'
            '<path d="M34 20l4-4a11 11 0 0116 16l-4 4"/>'
            '<path d="M30 44l-4 4a11 11 0 01-16-16l4-4"/></g>',
    ),
}

# ---------------------------------------------------------------------------
# Aliases: a second public name for an existing drawing. Nothing here adds
# geometry; the pack keeps exactly one shape per concept.
# ---------------------------------------------------------------------------
ALIASES = {
    'status-all': 'all-media',
    'on-the-air': 'channels',
    'top-rated': 'rating-star',
    'natural-language': 'sparkle',
    'photos': 'artwork',
    'preview': 'grid-view',
    'subtitles-edit': 'subtitles',
    'scan-library': 'scan',
    'default-edition': 'set-default',
    'episode': 'series',
    'author': 'user',
    'notifications': 'bell',
    'downloads': 'download',
    'api-key': 'key',
    'tables': 'database',
    'items': 'reel',
    'overview': 'dashboard',
    'grabbed': 'check',
}

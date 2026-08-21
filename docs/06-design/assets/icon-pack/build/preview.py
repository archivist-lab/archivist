# -*- coding: utf-8 -*-
"""Preview sheet for the Archivist icon pack.

Rendered by build_pack.py into archivist-icons.html. Uses the Archivist design
system directly: canvas #0a0a0f, the media domain colours, Bebas Neue for
display, DM Sans for interface text and JetBrains Mono for names and metadata.
Colour appears only where it carries meaning -- media domain, or state semantics.
"""
import html


# Colour is used only where it carries meaning: media domains and state semantics.
TINT = {
    'film': 'cyan', 'series': 'violet', 'music': 'pink', 'album': 'pink',
    'book': 'yellow', 'comics': 'orange', 'games': 'green', 'retrozone': 'green',
    'success': 'success', 'collected': 'success', 'warning': 'warning',
    'pending': 'warning', 'failure': 'danger', 'delete': 'danger',
    'live': 'pink', 'missing': 'dim',
}
GROUP_TINT = {
    'Player marks': 'cyan', 'Modules': 'fg', 'Navigation': 'cyan', 'Playback': 'cyan',
    'Actions': 'fg', 'Status': 'fg', 'Infrastructure': 'yellow',
    'Platforms': 'green', 'Awards': 'yellow',
}
GROUP_NOTE = {
    'Player marks': 'Idents. The three that carry a domain on their own, plus the product mark reduced to icon scale.',
    'Modules': 'The eight media domains. These are the only icons that take a fixed colour, and it is the domain colour.',
    'Navigation': 'Every destination in the Library sidebar, the Player rail, the Catalogue nav and the Control cockpit.',
    'Playback': 'Transport, tracks, and the media processing pipeline that Films and Series both surface.',
    'Actions': 'Verbs. If a control does something, its icon is here.',
    'Status': 'State. Never the sole carrier of meaning — always paired with text.',
    'Infrastructure': 'Servers, storage, indexers and the Control cockpit’s instruments.',
    'Platforms': 'Game platform families. These replace the emoji placeholders in the Games module and the Arcade.',
    'Awards': 'Festival and academy marks, hard-coded on the film information page.',
}

RAMP = ['film', 'search', 'settings', 'play', 'auto-grab', 'award-cannes']
BEFORE_AFTER = [
    ('🎬', 'film', 'Films'), ('📺', 'series', 'Series'), ('🦸', 'comics', 'Comics'),
    ('💚', 'platform-xbox', 'Xbox'), ('🔴', 'platform-nintendo-switch', 'Switch'),
    ('🦔', 'platform-genesis', 'Mega Drive'), ('🪐', 'platform-saturn', 'Saturn'),
    ('🌀', 'platform-sega', 'Sega'), ('🧹', 'track-cleaning', 'Tracks cleaned'),
    ('⌛', 'leaving-soon', 'Leaving soon'), ('🗃️', 'collections', 'Collections'),
    ('🐻', 'award-berlin', 'Berlin'),
]


def render(icons, aliases, groups):
    bodies = {i['name']: i['body'] for i in icons}
    man = {'groups': groups, 'icons': icons, 'aliases': aliases,
           'count': len(icons), 'aliasCount': len(aliases)}
    alias_by_target = {}
    for a, t in sorted(aliases.items()):
        alias_by_target.setdefault(t, []).append(a)

    def svg(name, size=34):
        return (f'<svg viewBox="0 0 64 64" width="{size}" height="{size}" fill="none" '
                f'aria-hidden="true">{bodies[name]}</svg>')


    ramp_cells = ''.join(
        '<div class="ramp-col">'
        + ''.join(f'<span class="ramp-cell">{svg(n, s)}</span>' for s in (16, 20, 24, 32, 48))
        + f'<span class="ramp-name">{n}</span></div>' for n in RAMP)

    ba_cells = ''.join(
        f'<div class="ba"><span class="ba-old">{html.escape(g)}</span>'
        f'<span class="ba-arrow" aria-hidden="true"></span>'
        f'<span class="ba-new">{svg(n, 30)}</span>'
        f'<span class="ba-label">{html.escape(label)}</span></div>'
        for g, n, label in BEFORE_AFTER)

    sections = []
    for group in man['groups']:
        rows = [i for i in man['icons'] if i['group'] == group]
        cells = []
        for i in rows:
            n = i['name']
            tint = TINT.get(n, GROUP_TINT[group])
            aka = alias_by_target.get(n, [])
            rep = ' '.join(i.get('replaces') or [])
            used = '; '.join(i.get('usedIn') or [])
            note = i.get('note', '')
            meta = []
            if rep:
                meta.append(f'<span class="was" title="Retires {html.escape(rep)}">{html.escape(rep)}</span>')
            if aka:
                meta.append(f'<span class="aka">{html.escape(", ".join(aka))}</span>')
            tip = html.escape(note or used or n)
            search = html.escape(' '.join([n] + aka + [used, rep]).lower())
            cells.append(
                f'<button class="cell" type="button" data-name="{html.escape(n)}" '
                f'data-search="{search}" data-tint="{tint}" title="{tip}">'
                f'{svg(n)}<span class="cell-name">{html.escape(n)}</span>'
                f'<span class="cell-meta">{"".join(meta) or "&nbsp;"}</span></button>')
        sections.append(
            f'<section class="group" data-group="{html.escape(group)}">'
            f'<div class="group-head"><h2>{html.escape(group)}</h2>'
            f'<span class="group-count">{len(rows)}</span>'
            f'<p class="group-note">{GROUP_NOTE[group]}</p></div>'
            f'<div class="grid">{"".join(cells)}</div></section>')

    alias_rows = ''.join(
        f'<tr><td><code>{html.escape(a)}</code></td><td>{svg(t, 20)}</td>'
        f'<td><code>{html.escape(t)}</code></td></tr>'
        for a, t in sorted(man['aliases'].items()))

    counts = ''.join(
        f'<div class="stat"><dt>{html.escape(g)}</dt>'
        f'<dd>{sum(1 for i in man["icons"] if i["group"] == g)}</dd></div>'
        for g in man['groups'])

    doc = f'''<title>Archivist Icon Pack</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=JetBrains+Mono:wght@400;500&display=swap">
    <style>
    :root {{
      --canvas:#0a0a0f; --s1:#111118; --s2:#1a1a24; --s3:#242430;
      --fg:rgba(255,255,255,.94); --text:rgba(255,255,255,.82);
      --muted:rgba(255,255,255,.58); --dim:rgba(255,255,255,.40);
      --line:rgba(255,255,255,.07); --line-2:rgba(255,255,255,.12);
      --cyan:#00d4ff; --violet:#9b59b6; --pink:#ff2d78; --yellow:#f1c40f;
      --orange:#e67e22; --green:#2ecc71;
      --success:#10b981; --warning:#f59e0b; --danger:#ef4444;
      --display:"Bebas Neue","Oswald",Impact,sans-serif;
      --body:"DM Sans",system-ui,-apple-system,sans-serif;
      --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
      --wrap:1240px;
    }}
    *,*::before,*::after {{ box-sizing:border-box; }}
    html {{ -webkit-text-size-adjust:100%; }}
    body {{
      margin:0; background:var(--canvas); color:var(--text);
      font-family:var(--body); font-size:15px; line-height:1.6;
      -webkit-font-smoothing:antialiased;
    }}
    .wrap {{ max-width:var(--wrap); margin:0 auto; padding:0 24px; }}

    /* ---------- masthead ---------- */
    .masthead {{ padding:72px 0 40px; border-bottom:1px solid var(--line); }}
    .eyebrow {{
      font-family:var(--mono); font-size:10.5px; letter-spacing:.22em;
      text-transform:uppercase; color:var(--dim); margin:0 0 18px;
    }}
    h1 {{
      font-family:var(--display); font-weight:400; font-size:clamp(52px,9vw,104px);
      line-height:.92; letter-spacing:.03em; text-transform:uppercase;
      color:var(--fg); margin:0; text-wrap:balance;
    }}
    h1 .accent {{ color:var(--cyan); }}
    .lede {{ max-width:62ch; margin:22px 0 0; color:var(--muted); font-size:16.5px; }}
    .lede strong {{ color:var(--fg); font-weight:500; }}

    .contract {{
      display:flex; flex-wrap:wrap; gap:8px; margin:28px 0 0; padding:0; list-style:none;
    }}
    .contract li {{
      font-family:var(--mono); font-size:11px; letter-spacing:.04em; color:var(--muted);
      background:var(--s2); border:1px solid var(--line); border-radius:6px; padding:5px 11px;
    }}
    .contract li b {{ color:var(--cyan); font-weight:500; }}

    .stats {{
      display:grid; grid-template-columns:repeat(auto-fit,minmax(94px,1fr));
      gap:1px; margin:44px 0 0; background:var(--line); border:1px solid var(--line);
      border-radius:10px; overflow:hidden;
    }}
    .stat {{ background:var(--s1); padding:14px 16px; }}
    .stat dt {{
      font-family:var(--mono); font-size:9.5px; letter-spacing:.16em;
      text-transform:uppercase; color:var(--dim); margin:0;
    }}
    .stat dd {{
      font-family:var(--display); font-size:30px; line-height:1; letter-spacing:.04em;
      color:var(--fg); margin:8px 0 0; font-variant-numeric:tabular-nums;
    }}

    /* ---------- band: retires ---------- */
    .band {{ padding:64px 0; border-bottom:1px solid var(--line); }}
    .band-head {{ display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; margin:0 0 8px; }}
    .band-head h2 {{
      font-family:var(--display); font-weight:400; font-size:32px; letter-spacing:.07em;
      text-transform:uppercase; color:var(--fg); margin:0;
    }}
    .band-head p {{ margin:0; color:var(--muted); max-width:58ch; font-size:14.5px; }}
    .ba-row {{
      display:grid; grid-template-columns:repeat(auto-fill,minmax(146px,1fr));
      gap:10px; margin-top:28px;
    }}
    .ba {{
      display:grid; grid-template-columns:auto 18px auto; align-items:center;
      justify-content:center; gap:6px;
      background:var(--s1); border:1px solid var(--line); border-radius:10px; padding:16px 10px 12px;
    }}
    .ba-old {{ font-size:22px; filter:grayscale(1); opacity:.42; line-height:1; }}
    .ba-arrow {{
      height:1px; background:linear-gradient(90deg,var(--line-2),var(--cyan)); position:relative;
    }}
    .ba-arrow::after {{
      content:""; position:absolute; right:-1px; top:-2.5px;
      border-left:5px solid var(--cyan); border-top:3px solid transparent; border-bottom:3px solid transparent;
    }}
    .ba-new {{ color:var(--cyan); display:flex; }}
    .ba-label {{
      grid-column:1 / -1; font-family:var(--mono); font-size:9.5px; letter-spacing:.08em;
      text-transform:uppercase; color:var(--dim); text-align:center; margin-top:10px;
    }}

    /* ---------- band: size ramp ---------- */
    .ramp {{ display:flex; flex-wrap:wrap; gap:10px; margin-top:28px; }}
    .ramp-col {{
      flex:1 1 168px; background:var(--s1); border:1px solid var(--line); border-radius:10px;
      padding:18px 12px 12px; display:flex; flex-direction:column; align-items:center; gap:14px;
    }}
    .ramp-cell {{ color:var(--fg); display:flex; align-items:center; justify-content:center; height:48px; }}
    .ramp-col {{ flex-direction:row; flex-wrap:wrap; justify-content:center; }}
    .ramp-name {{
      flex-basis:100%; text-align:center; font-family:var(--mono); font-size:9.5px;
      letter-spacing:.08em; color:var(--dim); margin-top:4px;
    }}

    /* ---------- filter ---------- */
    .toolbar {{
      position:sticky; top:0; z-index:5; background:rgba(10,10,15,.92);
      backdrop-filter:blur(10px); border-bottom:1px solid var(--line); padding:14px 0;
    }}
    .toolbar .wrap {{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; }}
    #filter {{
      flex:1 1 260px; min-width:0; background:var(--s2); border:1px solid var(--line-2);
      border-radius:8px; padding:10px 14px; color:var(--fg);
      font-family:var(--mono); font-size:12.5px; letter-spacing:.03em;
    }}
    #filter::placeholder {{ color:var(--dim); }}
    #filter:focus-visible {{ outline:2px solid var(--cyan); outline-offset:2px; border-color:transparent; }}
    #result {{
      font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase;
      color:var(--dim); white-space:nowrap; font-variant-numeric:tabular-nums;
    }}

    /* ---------- groups ---------- */
    .group {{ padding:56px 0 0; }}
    .group-head {{ display:grid; gap:6px; margin:0 0 22px; }}
    .group-head h2 {{
      grid-column:1; grid-row:1;
      font-family:var(--display); font-weight:400; font-size:30px; letter-spacing:.08em;
      text-transform:uppercase; color:var(--fg); margin:0;
    }}
    .group-count {{
      grid-column:2; grid-row:1; justify-self:start; align-self:center;
      font-family:var(--mono); font-size:11px; color:var(--cyan);
      border:1px solid rgba(0,212,255,.3); border-radius:5px; padding:2px 8px;
      font-variant-numeric:tabular-nums;
    }}
    .group-head::after {{
      content:""; grid-column:3; grid-row:1; align-self:center; height:1px; background:var(--line);
    }}
    .group-head {{ grid-template-columns:auto auto 1fr; }}
    .group-note {{ grid-column:1 / -1; grid-row:2; margin:0; color:var(--muted); font-size:14px; max-width:70ch; }}

    .grid {{ display:grid; gap:8px; grid-template-columns:repeat(auto-fill,minmax(152px,1fr)); }}
    .cell {{
      appearance:none; background:var(--s1); border:1px solid var(--line); border-radius:11px;
      padding:20px 10px 13px; display:flex; flex-direction:column; align-items:center; gap:11px;
      font:inherit; color:var(--fg); cursor:pointer; text-align:center;
      transition:border-color 140ms ease, background 140ms ease, transform 140ms ease;
    }}
    .cell:hover {{ background:var(--s2); border-color:var(--line-2); transform:translateY(-1px); }}
    .cell:focus-visible {{ outline:2px solid var(--cyan); outline-offset:2px; }}
    .cell[data-tint="cyan"] {{ color:var(--cyan); }}
    .cell[data-tint="violet"] {{ color:var(--violet); }}
    .cell[data-tint="pink"] {{ color:var(--pink); }}
    .cell[data-tint="yellow"] {{ color:var(--yellow); }}
    .cell[data-tint="orange"] {{ color:var(--orange); }}
    .cell[data-tint="green"] {{ color:var(--green); }}
    .cell[data-tint="success"] {{ color:var(--success); }}
    .cell[data-tint="warning"] {{ color:var(--warning); }}
    .cell[data-tint="danger"] {{ color:var(--danger); }}
    .cell[data-tint="dim"] {{ color:var(--dim); }}
    .cell[data-tint="fg"] {{ color:var(--fg); }}
    .cell-name {{
      font-family:var(--mono); font-size:10px; letter-spacing:.04em; color:var(--muted);
      word-break:break-word; line-height:1.35;
    }}
    .cell-meta {{ display:flex; align-items:center; gap:8px; min-height:15px; }}
    .was {{ font-size:12.5px; filter:grayscale(1); opacity:.5; line-height:1; }}
    .aka {{ font-family:var(--mono); font-size:8.5px; letter-spacing:.04em; color:var(--dim); }}
    .cell.hide {{ display:none; }}
    .group.hide {{ display:none; }}
    .copied {{ border-color:var(--cyan) !important; }}

    /* ---------- aliases ---------- */
    .aliases {{ padding:64px 0 96px; }}
    .table-scroll {{ overflow-x:auto; border:1px solid var(--line); border-radius:10px; }}
    table {{ border-collapse:collapse; width:100%; min-width:420px; }}
    th, td {{ text-align:left; padding:10px 16px; border-bottom:1px solid var(--line); }}
    th {{
      font-family:var(--mono); font-size:9.5px; letter-spacing:.16em; text-transform:uppercase;
      color:var(--dim); font-weight:400; background:var(--s1);
    }}
    tbody tr:last-child td {{ border-bottom:none; }}
    td code {{ font-family:var(--mono); font-size:12px; color:var(--text); }}
    td:nth-child(2) {{ color:var(--cyan); width:56px; }}

    footer {{ border-top:1px solid var(--line); padding:28px 0 72px; }}
    footer p {{ margin:0; font-family:var(--mono); font-size:11px; letter-spacing:.06em; color:var(--dim); }}

    @media (prefers-reduced-motion:reduce) {{
      * {{ transition:none !important; animation:none !important; }}
      .cell:hover {{ transform:none; }}
    }}
    </style>

    <div class="masthead"><div class="wrap">
      <p class="eyebrow">Design review · 19 August 2026</p>
      <h1>Archivist<br><span class="accent">Icon Pack</span></h1>
      <p class="lede">One stroke language across Library, Player, Catalogue and Control.
         <strong>{man['count']} icons, one drawing per concept</strong>, replacing the 108 emoji and
         Unicode glyphs the applications currently render through the host font — and the four
         competing icon systems that grew up alongside them.</p>
      <ul class="contract">
        <li>Grid <b>64 × 64</b></li>
        <li>Stroke <b>3</b></li>
        <li>Fill <b>currentColor</b></li>
        <li>Caps <b>round</b></li>
        <li>Aliases <b>{man['aliasCount']}</b></li>
        <li>Duplicate geometry <b>0</b></li>
      </ul>
      <dl class="stats">{counts}</dl>
    </div></div>

    <div class="band"><div class="wrap">
      <div class="band-head">
        <h2>What it retires</h2>
        <p>Every glyph on the left renders differently on Linux, Windows, macOS and a TV browser.
           None of them are drawn by Archivist.</p>
      </div>
      <div class="ba-row">{ba_cells}</div>
    </div></div>

    <div class="band"><div class="wrap">
      <div class="band-head">
        <h2>Optical compensation</h2>
        <p>Stroke weight grows as the icon shrinks — 3 units at 40px and above, 3.6 at 24, 5 below —
           so density stays constant. Shown at 16, 20, 24, 32 and 48px.</p>
      </div>
      <div class="ramp">{ramp_cells}</div>
    </div></div>

    <div class="toolbar"><div class="wrap">
      <input id="filter" type="search" placeholder="Filter by name, alias, retired glyph or surface…"
             aria-label="Filter icons" autocomplete="off">
      <span id="result">{man['count']} icons</span>
    </div></div>

    <div class="wrap" id="sheet">{''.join(sections)}</div>

    <div class="aliases"><div class="wrap">
      <div class="band-head">
        <h2>Aliases</h2>
        <p>Second names that resolve to an existing drawing, so a call site can say what it means
           without the pack growing a near-duplicate.</p>
      </div>
      <div class="table-scroll"><table>
        <thead><tr><th scope="col">Alias</th><th scope="col"></th><th scope="col">Resolves to</th></tr></thead>
        <tbody>{alias_rows}</tbody>
      </table></div>
    </div></div>

    <footer><div class="wrap">
      <p>docs/06-design/assets/icon-pack · click any icon to copy its name</p>
    </div></footer>

    <script>
    (function () {{
      var input = document.getElementById('filter');
      var result = document.getElementById('result');
      var cells = Array.prototype.slice.call(document.querySelectorAll('.cell'));
      var groups = Array.prototype.slice.call(document.querySelectorAll('.group'));

      input.addEventListener('input', function () {{
        var q = input.value.trim().toLowerCase();
        var shown = 0;
        cells.forEach(function (cell) {{
          var hit = !q || cell.dataset.search.indexOf(q) !== -1;
          cell.classList.toggle('hide', !hit);
          if (hit) shown++;
        }});
        groups.forEach(function (group) {{
          var any = group.querySelector('.cell:not(.hide)');
          group.classList.toggle('hide', !any);
        }});
        result.textContent = shown === cells.length
          ? cells.length + ' icons'
          : shown + ' of ' + cells.length;
      }});

      document.getElementById('sheet').addEventListener('click', function (event) {{
        var cell = event.target.closest('.cell');
        if (!cell) return;
        var name = cell.dataset.name;
        var done = function () {{
          cell.classList.add('copied');
          setTimeout(function () {{ cell.classList.remove('copied'); }}, 900);
          result.textContent = 'copied ' + name;
        }};
        if (navigator.clipboard && navigator.clipboard.writeText) {{
          navigator.clipboard.writeText(name).then(done, done);
        }} else {{
          done();
        }}
      }});
    }})();
    </script>
    '''
    return doc

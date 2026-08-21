#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the Archivist icon pack.

Inputs : source-2026-08-18.svg (the accepted look-and-feel set)
         additions.py          (redesigned + new geometry, aliases)
         retires.py            (what each icon replaces, and where)

Outputs (written to the pack root):
         archivist-icons.svg   sprite of <symbol> definitions
         Icon.tsx              React component with optical stroke compensation
         icons.json            machine-readable manifest
         archivist-icons.html  preview sheet
         svg/<name>.svg        one standalone file per icon

Pass --sync to also copy Icon.tsx into packages/design-system/src/, which is
what the applications import. The pack stays the source of truth; the package
holds a generated copy.
"""
import json, os, re, shutil, sys, html

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import additions, retires  # noqa: E402

GROUP_ORDER = ['Player marks', 'Modules', 'Navigation', 'Playback',
               'Actions', 'Status', 'Infrastructure', 'Platforms', 'Awards']


def load_source():
    raw = open(os.path.join(HERE, 'source-2026-08-18.svg'), encoding='utf-8').read()
    out = []
    for m in re.finditer(
            r'<symbol id="i-([^"]+)" viewBox="0 0 64 64" data-group="([^"]+)">(.*?)</symbol>',
            raw, re.S):
        out.append((m.group(1), m.group(2), re.sub(r'\s+', ' ', m.group(3)).strip()))
    return out


def build_icons():
    icons, seen = [], set()
    for name, group, body in load_source():
        if name in seen:
            raise SystemExit(f'duplicate id in source sprite: {name}')
        seen.add(name)
        if name in additions.REDESIGNS:
            group, body, note = additions.REDESIGNS[name]
            icons.append({'name': name, 'group': group, 'body': body, 'note': note})
        else:
            icons.append({'name': name, 'group': group, 'body': body})
    for name, entry in additions.REDESIGNS.items():
        if name not in seen:
            group, body, note = entry
            icons.append({'name': name, 'group': group, 'body': body, 'note': note})
            seen.add(name)
    for name, (group, body) in additions.NEW.items():
        if name in seen:
            raise SystemExit(f'new icon collides with an existing name: {name}')
        seen.add(name)
        icons.append({'name': name, 'group': group, 'body': body})

    for icon in icons:
        replaces, used = retires.RETIRES.get(icon['name'], ([], []))
        icon['replaces'] = replaces
        icon['usedIn'] = used

    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    unknown = sorted({i['group'] for i in icons} - set(order))
    if unknown:
        raise SystemExit(f'unknown groups: {unknown}')
    icons.sort(key=lambda i: (order[i['group']], i['name']))

    for alias, target in additions.ALIASES.items():
        if alias in seen:
            raise SystemExit(f'alias collides with a real icon: {alias}')
        if target not in seen:
            raise SystemExit(f'alias {alias} points at unknown icon {target}')
    return icons


def check_duplicate_geometry(icons):
    by_body = {}
    for icon in icons:
        by_body.setdefault(icon['body'], []).append(icon['name'])
    dupes = [v for v in by_body.values() if len(v) > 1]
    if dupes:
        raise SystemExit('duplicate geometry (use ALIASES instead): '
                         + '; '.join(' == '.join(d) for d in dupes))


# --- emitters --------------------------------------------------------------

def emit_sprite(icons):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" style="display:none" '
             'data-set="archivist-icons" data-grid="64" data-stroke="3" '
             f'data-count="{len(icons)}">']
    current = None
    for icon in icons:
        if icon['group'] != current:
            current = icon['group']
            parts.append(f'\n<!-- ============ {current.upper()} ============ -->')
        parts.append(
            f'<symbol id="i-{icon["name"]}" viewBox="0 0 64 64" '
            f'data-group="{icon["group"]}">\n  {icon["body"]}\n</symbol>')
    parts.append('\n</svg>\n')
    open(os.path.join(ROOT, 'archivist-icons.svg'), 'w', encoding='utf-8').write('\n'.join(parts))


def emit_standalone(icons):
    out = os.path.join(ROOT, 'svg')
    for stale in os.listdir(out):
        if stale.endswith('.svg'):
            os.remove(os.path.join(out, stale))
    for icon in icons:
        open(os.path.join(out, icon['name'] + '.svg'), 'w', encoding='utf-8').write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" '
            f'width="64" height="64" fill="none" role="img" aria-label="{icon["name"]}">\n'
            f'  {icon["body"]}\n</svg>\n')


ATTR = {
    'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
    'stroke-linejoin': 'strokeLinejoin', 'stroke-dasharray': 'strokeDasharray',
    'clip-path': 'clipPath', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule',
    'stroke-opacity': 'strokeOpacity', 'fill-opacity': 'fillOpacity',
}


def to_jsx(body):
    jsx = body.replace('stroke-width="3"', 'strokeWidth={w}')
    jsx = jsx.replace('stroke-width="2"', 'strokeWidth={w * 0.66}')
    jsx = re.sub(r'stroke-width="([\d.]+)"',
                 lambda m: 'strokeWidth={w * %s}' % round(float(m.group(1)) / 3, 3), jsx)
    for a, b in ATTR.items():
        jsx = jsx.replace(a + '=', b + '=')
    return jsx


def emit_tsx(icons):
    names = [i['name'] for i in icons]
    lines = [
        '// Generated by build/build_pack.py from archivist-icons.svg — do not edit by hand.',
        '// 64-unit grid, 3-unit stroke, inherits currentColor.',
        "import type { ReactElement, SVGProps } from 'react';",
        '',
        'const PATHS: Record<IconGlyph, (w: number) => ReactElement> = {',
    ]
    for icon in icons:
        jsx = to_jsx(icon['body'])
        # Icons drawn purely from fills never reference the stroke width.
        param = 'w' if '{w' in jsx else '_w'
        lines.append(f"  '{icon['name']}': ({param}: number) => <>{jsx}</>,")
    lines += ['};', '']

    lines.append('export type IconGlyph = ' + ' | '.join(f"'{n}'" for n in names) + ';')
    lines.append('')
    lines.append('/** Second names for an existing drawing: one shape per concept, many call sites. */')
    lines.append('export const ICON_ALIASES = {')
    for alias, target in sorted(additions.ALIASES.items()):
        lines.append(f"  '{alias}': '{target}',")
    lines += ['} as const satisfies Record<string, IconGlyph>;', '']
    lines += [
        'export type IconAlias = keyof typeof ICON_ALIASES;',
        'export type IconName = IconGlyph | IconAlias;',
        '',
        'function resolve(name: IconName): IconGlyph {',
        '  return (ICON_ALIASES as Record<string, IconGlyph>)[name] ?? (name as IconGlyph);',
        '}',
        '',
        "export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {",
        '  name: IconName;',
        '  /** Rendered size in px. Stroke is compensated below 24px so weight stays optically constant. */',
        '  size?: number;',
        '  /** Accessible name. Omit for decorative icons, which render aria-hidden. */',
        '  title?: string;',
        '}',
        '',
        '/** Optical stroke compensation: weight must grow as the icon shrinks or it disappears. */',
        'export function strokeFor(size: number): number {',
        '  if (size >= 40) return 3;',
        '  if (size >= 24) return 3.6;',
        '  return 5;',
        '}',
        '',
        'export function Icon({ name, size = 24, title, ...rest }: IconProps) {',
        '  return (',
        '    <svg',
        '      viewBox="0 0 64 64"',
        '      width={size}',
        '      height={size}',
        '      fill="none"',
        "      role={title ? 'img' : 'presentation'}",
        '      aria-hidden={title ? undefined : true}',
        '      {...rest}',
        '    >',
        '      {title ? <title>{title}</title> : null}',
        '      {PATHS[resolve(name)](strokeFor(size))}',
        '    </svg>',
        '  );',
        '}',
        '',
        'export const ICON_NAMES = ' + json.dumps(names, indent=2) + ' as const;',
        '',
        'const ALL_NAMES: ReadonlySet<string> = new Set<string>([',
        '  ...(ICON_NAMES as readonly string[]),',
        '  ...Object.keys(ICON_ALIASES),',
        ']);',
        '',
        '/**',
        ' * True when free-text names an icon in this pack, aliases included.',
        ' * Lets a surface that still stores glyphs migrate one value at a time.',
        ' */',
        'export function isIconName(value: string): value is IconName {',
        '  return ALL_NAMES.has(value);',
        '}',
        '',
    ]
    open(os.path.join(ROOT, 'Icon.tsx'), 'w', encoding='utf-8').write('\n'.join(lines))


def emit_manifest(icons):
    manifest = {
        'set': 'archivist-icons',
        'version': '2026-08-19',
        'grid': 64,
        'stroke': 3,
        'color': 'currentColor',
        'groups': GROUP_ORDER,
        'count': len(icons),
        'aliasCount': len(additions.ALIASES),
        'icons': [{k: icon[k] for k in ('name', 'group', 'replaces', 'usedIn', 'note')
                   if k in icon} for icon in icons],
        'aliases': dict(sorted(additions.ALIASES.items())),
    }
    open(os.path.join(ROOT, 'icons.json'), 'w', encoding='utf-8').write(
        json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')


def emit_preview(icons):
    import preview
    open(os.path.join(ROOT, 'archivist-icons.html'), 'w', encoding='utf-8').write(
        preview.render(icons, additions.ALIASES, GROUP_ORDER))


SYNC_TARGET = os.path.normpath(os.path.join(
    ROOT, '..', '..', '..', '..', 'packages', 'design-system', 'src', 'Icon.tsx'))


def sync_to_design_system():
    shutil.copyfile(os.path.join(ROOT, 'Icon.tsx'), SYNC_TARGET)
    print('synced ->', os.path.relpath(SYNC_TARGET, os.path.join(ROOT, '..', '..', '..', '..')))


def main():
    icons = build_icons()
    check_duplicate_geometry(icons)
    emit_sprite(icons)
    emit_standalone(icons)
    emit_tsx(icons)
    emit_manifest(icons)
    emit_preview(icons)
    missing = [i['name'] for i in icons if i['name'] not in retires.RETIRES]
    print(f'{len(icons)} icons, {len(additions.ALIASES)} aliases')
    for group in GROUP_ORDER:
        print(f'  {group:<16} {sum(1 for i in icons if i["group"] == group)}')
    if missing:
        print('no retirement metadata for:', ', '.join(missing))
    if '--sync' in sys.argv:
        sync_to_design_system()


if __name__ == '__main__':
    main()

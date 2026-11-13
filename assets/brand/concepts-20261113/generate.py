"""Preview-only brand concepts. Does not write production assets or application data."""
from pathlib import Path
from xml.sax.saxutils import escape
import json
import subprocess
from fontTools.ttLib import TTCollection, TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CLI = ROOT / 'node_modules/@tauri-apps/cli/tauri.js'

schemes = [
    dict(id='a-noir', label='A', name='Noir / 黑粉极简', short='NOIR',
         description='锐角 TL 连字，近黑底与冷粉色，偏专业、利落。',
         mark='<path d="M10 10H58L54 20H38L30 44H48L44 54H16L28 20H6Z" fill="currentColor"/>',
         accent='#F58CB8', text='#F8EDF4', background='#141217', ink='#21121B',
         font=0, word='Termlume',
         palette={'chrome':'#211C24','bg':'#141217','bar':'#1C181F','raise':'#28212B',
                  'border':'#3D323F','text':'#F8EDF4','muted':'#BBAFBE','selected':'#382B38',
                  'surface-hover':'#302632','accent':'#F58CB8','accent-soft':'#F58CB81C',
                  'primary':'#EBA0BE','primary-hover':'#F4B4CE','primary-border':'#F5B6D0',
                  'resource-fg':'#F3BED7','resource-bg':'#3B2936','group-fg':'#E7C5E4','group-bg':'#352C3B',
                  'terminal':'#100F13','terminal-text':'#F1E8EF','terminal-selection':'#513447'}),
    dict(id='b-wave', label='B', name='Wave / 柔光流线', short='WAVE',
         description='连续双弧线，粉紫柔光图标，偏轻盈、亲和。',
         mark='<path d="M10 44V24C10 9 32 9 32 24V40C32 55 54 55 54 40V20" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>',
         accent='#C6AEFF', text='#F2EEFC', background='#17151E', ink='#21162F',
         font=5, word='termlume',
         palette={'chrome':'#24212E','bg':'#17151E','bar':'#1E1B28','raise':'#2B2639',
                  'border':'#423A54','text':'#F2EEFC','muted':'#B9AFC9','selected':'#383044',
                  'surface-hover':'#332C40','accent':'#C6AEFF','accent-soft':'#C6AEFF1C',
                  'primary':'#C3ACEE','primary-hover':'#D5C3F7','primary-border':'#D5BEFF',
                  'resource-fg':'#E3C7F7','resource-bg':'#3D2C4A','group-fg':'#D7CAFB','group-bg':'#352E49',
                  'terminal':'#121018','terminal-text':'#EEE9F5','terminal-selection':'#423452'}),
    dict(id='c-pixel', label='C', name='Pixel / 复古玫瑰', short='PIXEL',
         description='像素终端徽记，柔粉底与暖黑色，偏复古、工具感。',
         mark='<path fill-rule="evenodd" d="M12 10H52V14H58V50H52V54H12V50H6V14H12ZM14 18V46H50V18Z" fill="currentColor"/><path d="M18 22H26V28H32V36H26V42H18V34H24V30H18ZM38 34H48V42H38Z" fill="currentColor"/>',
         accent='#ECA4B3', text='#F8EEEB', background='#191617', ink='#2B2025',
         font='mono', word='termlume',
         palette={'chrome':'#272123','bg':'#191617','bar':'#221D1F','raise':'#30282B',
                  'border':'#45383D','text':'#F8EEEB','muted':'#C0B1B5','selected':'#3C2F35',
                  'surface-hover':'#372B31','accent':'#ECA4B3','accent-soft':'#ECA4B31C',
                  'primary':'#DFA5B0','primary-hover':'#EAB9C2','primary-border':'#EAB9C2',
                  'resource-fg':'#EDC6CD','resource-bg':'#3D2E34','group-fg':'#E4CDD7','group-bg':'#3A2F36',
                  'terminal':'#131112','terminal-text':'#F1E5E5','terminal-selection':'#51383F'})
]

for s in schemes:
    s['palette'].update(success='#8EDAB4', warning='#F0CE86', danger='#FFACA6', **{'danger-soft':'#FFACA618'})
    directory = HERE / s['id']; directory.mkdir(exist_ok=True)
    mark = s['mark']
    (directory / 'mark.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" color="{s["accent"]}"><title>Termlume {s["short"]}</title>{mark}</svg>\n')
    font = TTFont('/System/Library/Fonts/Supplemental/Courier New Bold.ttf') if s['font'] == 'mono' else TTCollection('/System/Library/Fonts/Avenir Next.ttc').fonts[s['font']]
    glyphs = font.getGlyphSet(); cmap = font.getBestCmap(); advance = 0; paths = []
    cap = font['OS/2'].sCapHeight or 700
    factor = 42 / cap
    for i, char in enumerate(s['word']):
        name = cmap[ord(char)]
        if i == 1 and s['word'].startswith('T'): advance -= 55
        pen = SVGPathPen(glyphs); glyphs[name].draw(pen)
        paths.append(f'<path transform="translate({advance} 0)" d="{pen.getCommands()}"/>')
        advance += font['hmtx'][name][0] - (0 if s['font'] == 'mono' else 12)
    width = round(84 + advance * factor + 4, 2)
    logo = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="64" viewBox="0 0 {width} 64" color="{s["accent"]}"><title>Termlume {s["short"]} logo</title>{mark}<g fill="{s["text"]}" transform="translate(84 53) scale({factor} {-factor})">{"".join(paths)}</g></svg>'
    (directory / 'logo.svg').write_text(logo + '\n')
    (directory / 'logo-on-light.svg').write_text(logo.replace(s['text'],s['ink']).replace(s['accent'], '#AC356B' if s['label']=='A' else '#7751A5' if s['label']=='B' else '#A54F65') + '\n')
    s['logoWidth'] = width
    if s['label'] == 'A':
        defs = '<linearGradient id="tile" x2=".8" y2="1"><stop stop-color="#322630"/><stop offset=".5" stop-color="#1C171F"/><stop offset="1" stop-color="#100E13"/></linearGradient><linearGradient id="face" x2=".7" y2="1"><stop stop-color="#FFC2DB"/><stop offset="1" stop-color="#F078AC"/></linearGradient><filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2"/></filter>'
        tile = '<rect x="64" y="64" width="896" height="896" rx="202" fill="url(#tile)"/><rect x="66" y="66" width="892" height="892" rx="200" stroke="#9C6E89" stroke-opacity=".38" stroke-width="3"/>'
        art = f'<g transform="translate(192 192) scale(10)" color="#E75197"><g filter="url(#glow)" opacity=".14">{mark}</g></g><g transform="translate(192 192) scale(10)">{mark.replace("currentColor", "url(#face)")}</g>'
    elif s['label'] == 'B':
        defs = '<linearGradient id="tile" x1=".1" x2=".85" y2="1"><stop stop-color="#F5A2C6"/><stop offset=".48" stop-color="#CF8AD9"/><stop offset="1" stop-color="#8E75CA"/></linearGradient><linearGradient id="shine" y2="1"><stop stop-color="#FFFFFF" stop-opacity=".42"/><stop offset=".48" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient><linearGradient id="face" x2=".8" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#F8E9FF"/></linearGradient>'
        tile = '<rect x="64" y="64" width="896" height="896" rx="202" fill="url(#tile)"/><rect x="66" y="66" width="892" height="892" rx="200" fill="url(#shine)" stroke="#FFDDED" stroke-opacity=".5" stroke-width="3"/>'
        art = f'<g transform="translate(192 208) scale(10)" color="#714184" opacity=".2">{mark}</g><g transform="translate(192 186) scale(10)">{mark.replace("currentColor", "url(#face)")}</g>'
    else:
        defs = '<linearGradient id="tile" y2="1"><stop stop-color="#F4C7CF"/><stop offset="1" stop-color="#E7A4B3"/></linearGradient>'
        tile = '<rect x="64" y="64" width="896" height="896" rx="202" fill="url(#tile)"/><rect x="66" y="66" width="892" height="892" rx="200" stroke="#FFE5E9" stroke-width="3"/>'
        art = f'<g transform="translate(192 192) scale(10)" color="#2B2025">{mark}</g>'
    icon = f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none"><title>Termlume {s["short"]} app icon</title><defs>{defs}</defs>{tile}{art}</svg>'
    (directory / 'app-icon.svg').write_text(icon + '\n')
    css = ':root,:root[data-theme="dark"]{'+''.join(f'--{k}:{v};' for k,v in s['palette'].items())+'}\n.primary{color:'+s['ink']+';}\n.brand-mark{color:var(--accent);}\n'
    (directory / 'theme-preview.css').write_text(css)
    for name,size in [('app-icon',1024),('logo',1200),('logo-on-light',1200),('mark',128)]:
        subprocess.run(['node',str(CLI),'icon',str(directory/f'{name}.svg'),'--output',str(directory/'rendered'),'--fit','contain','--png',str(size)],check=True,capture_output=True)
        from PIL import Image
        im = Image.open(directory/'rendered'/f'{size}x{size}.png')
        if name.startswith('logo'):
            h = 1200 * 64 / width
            im = im.crop((0,round((1200-h)/2),1200,round((1200+h)/2)))
        im.save(directory/f'{name}.png')
    import shutil
    shutil.rmtree(directory/'rendered')

(HERE/'schemes.json').write_text(json.dumps(schemes,ensure_ascii=False,indent=2)+'\n')
print('Created three isolated vector concepts and PNG previews.')

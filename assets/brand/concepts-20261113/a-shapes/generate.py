"""Three alternative symbols, keeping the approved A palette, wordmark and icon tile."""
from pathlib import Path
import json
import re
import shutil
import subprocess
from xml.etree import ElementTree as ET
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE = HERE.parent / 'a-noir'
CLI = ROOT / 'node_modules/@tauri-apps/cli/tauri.js'
ACCENT = '#F58CB8'
TEXT = '#F8EDF4'
MUTED = '#BBAFBE'
BG = '#141217'

variants = [
    dict(id='a1-cursor', label='A1', name='光标',
         concept='提示符 + 发光光标', tone='直接、清晰的终端识别',
         description='保留终端语言，用圆角线条减轻硬朗感。',
         mark='<path d="M12 16 29 32 12 48" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><rect x="46" y="16" width="10" height="32" rx="3" fill="currentColor"/>'),
    dict(id='a2-portal', label='A2', name='光门',
         concept='开放的门框 + 光点', tone='更抽象，更有独立品牌感',
         description='打开的窗口与浮起的一角，表达连接和光。',
         mark='<path d="M38 10H24C16 10 10 16 10 24V40C10 48 16 54 24 54H40C48 54 54 48 54 40V32" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><rect x="46" y="6" width="12" height="12" rx="3" fill="currentColor"/>'),
    dict(id='a3-nightcat', label='A3', name='夜猫',
         concept='猫耳轮廓 + 终端表情', tone='更有个性，也更容易记住',
         description='将命令提示符藏进表情，偏开发者工具气质。',
         mark='<path fill-rule="evenodd" d="M10 28V11C10 8 12 7 15 10L25 19C29 18 35 18 39 19L49 10C52 7 54 8 54 11V28C59 39 54 47 47 51C40 55 24 55 17 51C10 47 5 39 10 28ZM18 29 25 35 18 41 15 38 19 35 15 32ZM35 37H45V41H35Z" fill="currentColor"/>')
]

base_logo = (BASE/'logo.svg').read_text()
base_icon = (BASE/'app-icon.svg').read_text()
logo_root = ET.fromstring(base_logo)
width = logo_root.attrib['width']
word = re.search(r'<g fill=.*</g>',base_logo).group(0)
defs = re.search(r'<defs>.*?</defs>',base_icon).group(0)
tile = ''.join(re.findall(r'<rect x="6[46]".*?/>',base_icon))
assert tile.count('<rect') == 2

def render(folder, name, size):
    temporary = folder/'rendered'
    subprocess.run(['node',str(CLI),'icon',str(folder/f'{name}.svg'),'--output',str(temporary),
                    '--fit','contain','--png',str(size)],check=True,capture_output=True)
    im = Image.open(temporary/f'{size}x{size}.png').convert('RGBA')
    if name.startswith('logo'):
        h = size * 64 / float(width)
        im = im.crop((0,round((size-h)/2),size,round((size+h)/2)))
    im.save(folder/f'{name}.png')
    shutil.rmtree(temporary)

for v in variants:
    folder=HERE/v['id']; folder.mkdir(exist_ok=True)
    mark=v['mark']
    (folder/'mark.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" color="{ACCENT}"><title>Termlume {v["label"]} {v["name"]}</title>{mark}</svg>\n')
    logo=f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="64" viewBox="0 0 {width} 64" color="{ACCENT}"><title>Termlume {v["label"]}</title>{mark}{word}</svg>'
    (folder/'logo.svg').write_text(logo+'\n')
    (folder/'logo-on-light.svg').write_text(logo.replace(TEXT,'#21121B').replace(ACCENT,'#AC356B')+'\n')
    art = f'<g transform="translate(192 192) scale(10)" color="#E75197"><g filter="url(#glow)" opacity=".14">{mark}</g></g><g transform="translate(192 192) scale(10)">{mark.replace("currentColor","url(#face)")}</g>'
    icon = f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none"><title>Termlume {v["label"]} app icon</title>{defs}{tile}{art}</svg>'
    (folder/'app-icon.svg').write_text(icon+'\n')
    for name,size in [('app-icon',1024),('mark',128),('logo',1200),('logo-on-light',1200)]:
        render(folder,name,size)

LATIN='/System/Library/Fonts/Supplemental/Arial.ttf'
CHINESE='/System/Library/Fonts/STHeiti Medium.ttc'
def font(size,zh=False):return ImageFont.truetype(CHINESE if zh else LATIN,size)
def paste(board,path,xy,size):
    im=Image.open(path).convert('RGBA').resize(size,Image.Resampling.LANCZOS)
    board.paste(im,xy,im)

board=Image.new('RGB',(1800,1152),'#111014'); d=ImageDraw.Draw(board)
d.text((56,42),'Termlume / A 方案的三种新形态',fill=TEXT,font=font(40,True))
d.text((56,106),'保留黑粉配色、字标与图标质感，只比较符号造型',fill=MUTED,font=font(24,True))
for i,v in enumerate(variants):
    x=48+i*576; folder=HERE/v['id']
    d.rounded_rectangle((x,176,x+552,1104),radius=24,fill=BG,outline='#3D323F',width=2)
    d.text((x+32,210),f'{v["label"]}  {v["name"]}',fill=TEXT,font=font(34,True))
    d.text((x+32,268),v['concept'],fill=ACCENT,font=font(25,True))
    paste(board,folder/'app-icon.png',(x+106,320),(340,340))
    logo=Image.open(folder/'logo.png'); w=464; h=round(w*logo.height/logo.width)
    paste(board,folder/'logo.png',(x+44,710),(w,h))
    d.rounded_rectangle((x+30,850,x+522,954),radius=14,fill='#F7F1F4')
    w=450; h=round(w*logo.height/logo.width)
    paste(board,folder/'logo-on-light.png',(x+51,850+(104-h)//2),(w,h))
    for size,offset in [(24,52),(40,112),(64,186)]:
        paste(board,folder/'app-icon.png',(x+offset,1040-size),(size,size))
    d.text((x+296,1002),'24 / 40 / 64 px',fill=MUTED,font=font(20))
    d.text((x+32,1060),v['tone'],fill=MUTED,font=font(23,True))
board.save(HERE/'comparison.png')
(HERE/'variants.json').write_text(json.dumps(variants,ensure_ascii=False,indent=2)+'\n')
print('Created A1/A2/A3 symbols, logos and app icons; production assets untouched.')

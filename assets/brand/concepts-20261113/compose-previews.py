"""Compose design boards from the vector exports and isolated UI captures."""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SCHEMES = json.loads((HERE/'schemes.json').read_text())
LATIN = '/System/Library/Fonts/Supplemental/Arial.ttf'
CHINESE = '/System/Library/Fonts/STHeiti Medium.ttc'

def font(size, chinese=False):
    return ImageFont.truetype(CHINESE if chinese else LATIN, size)

def paste_image(board, path, pos, size):
    im = Image.open(path).convert('RGBA').resize(size,Image.Resampling.LANCZOS)
    board.paste(im,pos,im)

for s in SCHEMES:
    folder=HERE/s['id']; p=s['palette']
    board=Image.new('RGB',(1400,1320),s['background']); d=ImageDraw.Draw(board)
    d.text((56,40),f'{s["label"]} / {s["short"]}',fill=s['accent'],font=font(22))
    d.text((56,86),s['name'].split(' / ')[1],fill=s['text'],font=font(40,True))
    d.text((56,146),s['description'],fill=p['muted'],font=font(23,True))
    logo=Image.open(folder/'logo.png')
    w=650; h=round(w*logo.height/logo.width)
    paste_image(board,folder/'logo.png',(56,234),(w,h))
    d.rounded_rectangle((56,350,766,470),radius=16,fill='#F7F1F4' if s['label']!='B' else '#F4F0FA')
    w=500; h=round(w*logo.height/logo.width)
    paste_image(board,folder/'logo-on-light.png',(84,350+(120-h)//2),(w,h))
    paste_image(board,folder/'app-icon.png',(932,146),(380,380))
    for size,x in [(24,1000),(40,1068),(64,1152)]:
        paste_image(board,folder/'app-icon.png',(x,552-size),(size,size))
    d.text((992,568),'24 / 40 / 64 px',fill=p['muted'],font=font(18))
    swatches=[('背景',p['bg']),('面板',p['bar']),('主色',p['accent']),('文字',p['text'])]
    for i,(label,color) in enumerate(swatches):
        x=56+i*178
        d.rounded_rectangle((x,506,x+142,532),radius=7,fill=color,outline=p['border'],width=1)
        d.text((x,544),label,fill=p['muted'],font=font(17,True))
        d.text((x,568),color.upper(),fill=p['muted'],font=font(17))
    d.text((56,622),'界面主题预览',fill=s['text'],font=font(24,True))
    d.text((1140,628),'虚构演示数据',fill=p['muted'],font=font(17,True))
    # Round the screenshot's corners while retaining every pixel of the actual UI.
    ui=Image.open(folder/'theme-preview.png').convert('RGB').resize((1288,644),Image.Resampling.LANCZOS)
    mask=Image.new('L',ui.size,0); ImageDraw.Draw(mask).rounded_rectangle((0,0,1287,643),radius=16,fill=255)
    board.paste(ui,(56,666),mask)
    board.save(folder/'preview.png')

# Quick comparison: geometry, logo, icon and palette visible together.
overview=Image.new('RGB',(1800,1040),'#121115'); d=ImageDraw.Draw(overview)
d.text((64,48),'Termlume / 三种品牌方向',fill='#F4EDF3',font=font(40,True))
d.text((64,110),'Logo · App icon · 主题配色',fill='#BBAFBE',font=font(24,True))
for i,s in enumerate(SCHEMES):
    x=48+i*576; p=s['palette']; folder=HERE/s['id']
    d.rounded_rectangle((x,178,x+552,984),radius=24,fill=s['background'],outline=p['border'],width=2)
    d.text((x+32,212),f'{s["label"]}  {s["name"].split(" / ")[1]}',fill=s['text'],font=font(30,True))
    paste_image(overview,folder/'app-icon.png',(x+116,278),(320,320))
    logo=Image.open(folder/'logo.png'); w=460; h=round(w*logo.height/logo.width)
    paste_image(overview,folder/'logo.png',(x+46,650),(w,h))
    for j,code in enumerate([p['bg'],p['bar'],p['accent'],p['text']]):
        left=x+40+j*122
        d.rounded_rectangle((left,804,left+106,844),radius=10,fill=code,outline=p['border'],width=1)
    caption={'A':'斜切连字 / 黑底冷粉','B':'连续曲线 / 粉紫柔光','C':'像素终端 / 暖黑玫瑰'}[s['label']]
    d.text((x+40,894),caption,fill=p['muted'],font=font(24,True))
overview.save(HERE/'comparison.png')
print('Saved three full boards and one comparison preview.')

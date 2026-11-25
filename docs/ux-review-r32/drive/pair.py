import sys
from PIL import Image, ImageDraw
out, *pairs = sys.argv[1:]
ims=[(p, Image.open(p).convert("RGB")) for p in pairs]
# crop each to the Lead 75 region: rows are approx; just keep top 340px
ims=[(p, im.crop((0,0,im.width,min(im.height,330)))) for p,im in ims]
W=sum(i.width for _,i in ims)+10*(len(ims)-1); H=max(i.height for _,i in ims)+18
c=Image.new("RGB",(W,H),(128,128,128)); x=0; d=ImageDraw.Draw(c)
for p,i in ims: c.paste(i,(x,18)); d.text((x+2,3),p.replace(".png",""),fill=(255,255,255)); x+=i.width+10
c.save(out)

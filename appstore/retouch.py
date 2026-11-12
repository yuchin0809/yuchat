#!/usr/bin/env python3
"""スクリーンショットの時計・メッセージの時刻を、会話の内容に合う時刻に直す（ほかは、いじらない）。
時刻の文字だけを、まわりの背景の色で消して、同じ大きさ・色で書き直す。画面共有の緑のしるしも消す。
mode："dark"＝明るい背景の上の暗い文字／"light"＝色つきの背景の上の明るい文字／"white"＝暗い背景の上の白い文字"""
from PIL import Image, ImageDraw, ImageFont
FONT = "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf"

def is_text(c, mode):
    r, g, b = c[:3]
    if mode == "dark": return (r + g + b) / 3 < 175
    if mode == "light": return g > 185 and r > 230          # ピンクの背景の上の、うすいピンク／白の文字
    return (r + g + b) / 3 > 170                              # white

def retime(im, cx, cy, new, mode="dark", w=120, h=26, gap=9, wr=None, minw=6, maxh=None):
    px = im.load()
    x_lo, x_hi = max(0, cx - w), min(im.width - 1, cx + (wr if wr is not None else w)); y_lo, y_hi = max(0, cy - h), min(im.height - 1, cy + h)
    cols = {}
    for x in range(x_lo, x_hi + 1):
        ys = [y for y in range(y_lo, y_hi + 1) if is_text(px[x, y], mode)]
        if ys: cols[x] = ys
    xs = sorted(cols); groups, cur = [], None
    for x in xs:
        if cur is None or x - cur[1] > gap: cur = [x, x, min(cols[x]), max(cols[x])]; groups.append(cur)
        else: cur[1] = x; cur[2] = min(cur[2], min(cols[x])); cur[3] = max(cur[3], max(cols[x]))
    groups = [g for g in groups if g[1] - g[0] >= minw and (maxh is None or g[3] - g[2] <= maxh)]
    if not groups: print("見つからない", cx, cy, mode); return
    g = groups[-1]; x0, x1, y0, y1 = g[0] - 3, g[1] + 3, g[2] - 3, g[3] + 3
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(im.width - 1, x1), min(im.height - 1, y1)
    fg = max((px[x, y] for x in range(x0, x1) for y in range(y0, y1)), key=lambda c: abs(sum(c[:3]) - sum(px[max(0, x0 - 6), (y0 + y1) // 2][:3])))
    for y in range(y0, y1 + 1):
        left = px[max(0, x0 - 6), y]
        for x in range(x0, x1 + 1): px[x, y] = left
    size = int(((y1 - y0) - 6) / 0.72)
    f = ImageFont.truetype(FONT, size); d = ImageDraw.Draw(im)
    d.text((x1 - 3 - d.textlength(new, font=f), y1 - 3), new, font=f, fill=fg, anchor="ls")

def hide_green(im, x0, y0, x1, y1, fill):
    px = im.load()
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y][:3]
            if g > r + 12 and g > b + 12: px[x, y] = fill

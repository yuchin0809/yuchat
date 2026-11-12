#!/usr/bin/env python3
"""ゆうChat の App Store 用スクリーンショットを作る（見出し＋端末の枠＋実機の画面）。
使い方：
  python3 make_screenshots.py iphone 出力フォルダ  画面1.png "見出し1" 画面2.png "見出し2" ...
  python3 make_screenshots.py ipad   出力フォルダ  画面1.png "見出し1" ...
・画面は、本物のアプリ（TestFlight）で撮ったスクリーンショット。作り物の画面は使わない（Apple の規則）。
・見出しの改行は、"1行目\\n2行目" のように \\n を入れる。
・出力：iphone＝1320×2868（6.9インチ）／ ipad＝2752×2064（13インチ・横向き）。"""
import sys, os
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"
SIZES = {"iphone": dict(W=1320, H=2868, frame_w=0.80, bezel=26, radius=120, head=112, top=190, crop=True),
         "ipad":   dict(W=2752, H=2064, frame_w=0.92, bezel=30, radius=70, head=120, top=130, crop=False)}
BG_TOP, BG_BOTTOM, INK, ACCENT = (232, 241, 255), (246, 249, 255), (24, 32, 52), (47, 107, 255)

def gradient(w, h):
    img = Image.new("RGB", (w, h)); d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1); d.line([(0, y), (w, y)], fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    return img

def rounded_mask(size, r):
    m = Image.new("L", size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], r, fill=255); return m

def make(kind, shot_path, headline, out_path):
    c = SIZES[kind]; W, H = c["W"], c["H"]
    canvas = gradient(W, H); d = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT, c["head"])
    lines = headline.replace("\\n", "\n").split("\n")
    y = c["top"]
    for ln in lines:   # 太字っぽく見せるため、ふちを付ける
        tw = d.textlength(ln, font=font)
        d.text(((W - tw) / 2, y), ln, font=font, fill=INK, stroke_width=3, stroke_fill=INK)
        y += int(c["head"] * 1.25)
    d.rounded_rectangle([W / 2 - 60, y + 10, W / 2 + 60, y + 22], 6, fill=ACCENT)   # 見出しの下の線
    shot = Image.open(shot_path).convert("RGB")
    fw = int(W * c["frame_w"]); inner_w = fw - 2 * c["bezel"]
    inner_h = int(shot.height * inner_w / shot.width); shot = shot.resize((inner_w, inner_h), Image.LANCZOS)
    top = y + 90
    if not c["crop"]:   # iPad：枠ぜんぶが入るように、画面を縮める
        avail = H - top - 80
        if inner_h + 2 * c["bezel"] > avail:
            inner_h = avail - 2 * c["bezel"]; inner_w = int(shot.width * inner_h / shot.height); shot = shot.resize((inner_w, inner_h), Image.LANCZOS); fw = inner_w + 2 * c["bezel"]
    fh = inner_h + 2 * c["bezel"]
    frame = Image.new("RGBA", (fw, fh), (0, 0, 0, 0)); fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle([0, 0, fw - 1, fh - 1], c["radius"], fill=(18, 20, 26, 255))
    inner = Image.new("RGBA", (inner_w, inner_h)); inner.paste(shot, (0, 0))
    frame.paste(inner, (c["bezel"], c["bezel"]), rounded_mask((inner_w, inner_h), max(20, c["radius"] - c["bezel"])))
    # 影
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0)); sd = ImageDraw.Draw(shadow)
    x = (W - fw) // 2
    sd.rounded_rectangle([x + 10, top + 24, x + fw + 10, top + fh + 24], c["radius"], fill=(30, 50, 100, 70))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow)
    canvas.alpha_composite(frame, (x, top))
    canvas.convert("RGB").save(out_path, "PNG")   # App Store は、透明なし・RGB の PNG

if __name__ == "__main__":
    if len(sys.argv) < 5 or (len(sys.argv) - 3) % 2: sys.exit(__doc__)
    kind, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
    pairs = sys.argv[3:]
    for i in range(0, len(pairs), 2):
        p = os.path.join(out, f"{kind}-{i // 2 + 1}.png"); make(kind, pairs[i], pairs[i + 1], p); print(p)

# SPDX-License-Identifier: GPL-3.0-or-later
"""Composes the README images from the real tray render and the demo screenshots.

hero.png shows the tray in the bottom-left corner of a desktop while one screenshot
is dragged into an app window. tray.png shows the tray on its own.
Usage: compose_readme_images.py TRAY_PNG SHOTS_DIR OUT_DIR
"""
import math
import os
import sys

import cairo

W, H = 1280, 720          # the hero's layout, in screen points
HERO_SCALE = 1.5          # saved at 1920 x 1080
TRAY_SCALE = 2            # the tray render is drawn at 2x
MARGIN = 16               # the add-on keeps the tray this far from the edges

tray_png, shots_dir, out_dir = sys.argv[1:4]
os.makedirs(out_dir, exist_ok=True)
FONT = 'Ubuntu Sans'
MONO = 'Ubuntu Mono'


def rgb(hex_colour):
    value = hex_colour.lstrip('#')
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


def rounded(ctx, x, y, w, h, r):
    ctx.new_sub_path()
    ctx.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    ctx.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    ctx.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    ctx.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    ctx.close_path()


def soft_shadow(ctx, x, y, w, h, r, blur=22, offset=12, strength=0.5):
    # Many faint, growing outlines add up to a soft shadow.
    for i in range(blur, 0, -1):
        ctx.set_source_rgba(0.04, 0.0, 0.08, strength / blur * (1 - i / (blur + 1)) * 1.6)
        rounded(ctx, x - i, y - i + offset, w + 2 * i, h + 2 * i, r + i)
        ctx.fill()


def text(ctx, x, y, words, size, colour, font=FONT, bold=False, alpha=1.0, centre=False):
    ctx.select_font_face(font, cairo.FONT_SLANT_NORMAL,
                         cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL)
    ctx.set_font_size(size)
    if centre:
        x -= ctx.text_extents(words).x_advance / 2
    ctx.set_source_rgba(*rgb(colour), alpha)
    ctx.move_to(x, y)
    ctx.show_text(words)


def backdrop(ctx, w, h):
    gradient = cairo.LinearGradient(0, 0, w, h)
    gradient.add_color_stop_rgb(0, *rgb('#1B0930'))
    gradient.add_color_stop_rgb(1, *rgb('#4A1D6E'))
    ctx.set_source(gradient)
    ctx.paint()
    for cx, cy, radius, colour, alpha in ((w * 0.82, h * 0.15, w * 0.42, '#7B3FB0', 0.45),
                                          (w * 0.95, h * 0.98, w * 0.34, '#FF8466', 0.16),
                                          (w * 0.10, h * 0.08, w * 0.30, '#5E2B8C', 0.35)):
        glow = cairo.RadialGradient(cx, cy, 0, cx, cy, radius)
        glow.add_color_stop_rgba(0, *rgb(colour), alpha)
        glow.add_color_stop_rgba(1, *rgb(colour), 0)
        ctx.set_source(glow)
        ctx.paint()


def draw_image(ctx, surface, x, y, w, h, radius=0.0, alpha=1.0):
    ctx.save()
    if radius:
        rounded(ctx, x, y, w, h, radius)
        ctx.clip()
    ctx.translate(x, y)
    ctx.scale(w / surface.get_width(), h / surface.get_height())
    ctx.set_source_surface(surface, 0, 0)
    ctx.get_source().set_filter(cairo.FILTER_GOOD)
    ctx.paint_with_alpha(alpha)
    ctx.restore()


def pointer(ctx, x, y):
    ctx.save()
    ctx.translate(x, y)
    ctx.move_to(0, 0)
    for px, py in ((0, 25), (6.5, 19), (11, 29.5), (15.5, 27.5), (11, 18), (19.5, 18)):
        ctx.line_to(px, py)
    ctx.close_path()
    ctx.set_source_rgb(1, 1, 1)
    ctx.fill_preserve()
    ctx.set_line_width(1.6)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.set_source_rgb(0.1, 0.07, 0.14)
    ctx.stroke()
    ctx.restore()


tray = cairo.ImageSurface.create_from_png(tray_png)
tray_w, tray_h = tray.get_width() / TRAY_SCALE, tray.get_height() / TRAY_SCALE
dragged = cairo.ImageSurface.create_from_png(os.path.join(shots_dir, '1-code.png'))

# --- hero.png ---------------------------------------------------------------
hero = cairo.ImageSurface(cairo.FORMAT_ARGB32, int(W * HERO_SCALE), int(H * HERO_SCALE))
ctx = cairo.Context(hero)
ctx.scale(HERO_SCALE, HERO_SCALE)
backdrop(ctx, W, H)

# GNOME's top bar
ctx.set_source_rgba(0, 0, 0, 0.55)
ctx.rectangle(0, 0, W, 26)
ctx.fill()
text(ctx, W / 2, 18, 'Thu 25 Sep  14:02', 13, '#FFFFFF', bold=True, alpha=0.9, centre=True)

# an app window: a terminal waiting for the screenshot
wx, wy, ww, wh = 470, 92, 742, 470
soft_shadow(ctx, wx, wy, ww, wh, 14)
rounded(ctx, wx, wy, ww, wh, 14)
ctx.set_source_rgb(*rgb('#1C1A27'))
ctx.fill()
ctx.save()
rounded(ctx, wx, wy, ww, wh, 14)
ctx.clip()
ctx.set_source_rgb(*rgb('#252233'))
ctx.rectangle(wx, wy, ww, 46)
ctx.fill()
ctx.restore()
text(ctx, wx + ww / 2, wy + 29, 'Terminal', 15, '#D8D4E8', bold=True, centre=True)
ctx.set_source_rgb(*rgb('#3A3650'))
ctx.arc(wx + ww - 26, wy + 23, 11, 0, 2 * math.pi)
ctx.fill()
ctx.set_source_rgb(*rgb('#D8D4E8'))
ctx.set_line_width(1.8)
for dx, dy in ((-4, -4), (-4, 4)):
    ctx.move_to(wx + ww - 26 + dx, wy + 23 + dy)
    ctx.line_to(wx + ww - 26 - dx, wy + 23 - dy)
ctx.stroke()
text(ctx, wx + 28, wy + 96, '›', 19, '#B98AF0', font=MONO, bold=True)
text(ctx, wx + 48, wy + 96, "Here's the bug in the header:", 19, '#E8E6F0', font=MONO)

# where the screenshot will land
zx, zy, zw, zh = wx + 28, wy + 128, ww - 56, 300
rounded(ctx, zx, zy, zw, zh, 12)
ctx.set_source_rgba(*rgb('#B98AF0'), 0.08)
ctx.fill_preserve()
ctx.set_source_rgba(*rgb('#B98AF0'), 0.85)
ctx.set_line_width(2)
ctx.set_dash([8, 6])
ctx.stroke()
ctx.set_dash([])
text(ctx, zx + zw / 2, zy + zh - 22, 'Drop to add the screenshot', 15, '#B98AF0', centre=True)

# the screenshot being dragged, with the pointer holding it
card_w, card_h = 220, 139
gx, gy = zx + zw / 2 - card_w / 2 - 20, zy + 56
ctx.save()
ctx.translate(gx + card_w / 2, gy + card_h / 2)
ctx.rotate(math.radians(-4))
ctx.translate(-card_w / 2, -card_h / 2)
soft_shadow(ctx, 0, 0, card_w, card_h, 12, blur=16, offset=10, strength=0.55)
draw_image(ctx, dragged, 0, 0, card_w, card_h, radius=12, alpha=0.95)
rounded(ctx, 0.5, 0.5, card_w - 1, card_h - 1, 12)
ctx.set_source_rgba(1, 1, 1, 0.12)
ctx.set_line_width(1)
ctx.stroke()
ctx.restore()
pointer(ctx, gx + 150, gy + 92)

# the tray, exactly where the add-on keeps it
tx, ty = MARGIN, H - MARGIN - tray_h
draw_image(ctx, tray, tx, ty, tray_w, tray_h)

# the path the screenshot travelled
ctx.set_source_rgba(1, 1, 1, 0.45)
ctx.set_line_width(2.4)
ctx.set_line_cap(cairo.LINE_CAP_ROUND)
ctx.set_dash([0.1, 9])
ctx.move_to(tx + tray_w - 6, ty + 70)
ctx.curve_to(360, ty - 40, 470, gy + 180, gx - 10, gy + card_h / 2 + 10)
ctx.stroke()
ctx.set_dash([])

hero.write_to_png(os.path.join(out_dir, 'hero.png'))
print('image: hero.png')

# --- tray.png ---------------------------------------------------------------
PAD = 36
panel = cairo.ImageSurface(cairo.FORMAT_ARGB32,
                           int((tray_w + 2 * PAD) * TRAY_SCALE), int((tray_h + 2 * PAD) * TRAY_SCALE))
ctx = cairo.Context(panel)
ctx.scale(TRAY_SCALE, TRAY_SCALE)
rounded(ctx, 0, 0, tray_w + 2 * PAD, tray_h + 2 * PAD, 28)
ctx.clip()
backdrop(ctx, tray_w + 2 * PAD, tray_h + 2 * PAD)
draw_image(ctx, tray, PAD, PAD, tray_w, tray_h)
panel.write_to_png(os.path.join(out_dir, 'tray.png'))
print('image: tray.png')

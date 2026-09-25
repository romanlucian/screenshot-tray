# SPDX-License-Identifier: GPL-3.0-or-later
"""Renders the demo "screenshots" (tools/demo/*.svg) to PNG files.

They are spaced a minute apart by file name, so the tray sees the last one as newest.
Usage: render_demo_shots.py SVG_DIR OUT_DIR
"""
import os
import sys
import time

import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

source, out = sys.argv[1:3]
os.makedirs(out, exist_ok=True)
names = sorted(name for name in os.listdir(source) if name.endswith('.svg'))
now = time.time()
for index, name in enumerate(names):
    picture = GdkPixbuf.Pixbuf.new_from_file(os.path.join(source, name))
    path = os.path.join(out, name[:-len('.svg')] + '.png')
    picture.savev(path, 'png', [], [])
    stamp = now - (len(names) - index) * 60
    os.utime(path, (stamp, stamp))
    print(f'demo shot: {os.path.basename(path)}')

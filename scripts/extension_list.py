# SPDX-License-Identifier: GPL-3.0-or-later
"""Adds or removes one add-on in GNOME's enabled-extensions list, leaving the rest as is.

Usage: extension_list.py add|remove UUID "<current gsettings value>"
Prints the new value for `gsettings set org.gnome.shell enabled-extensions`.
"""
import ast
import sys

action, uuid, current = sys.argv[1:4]
if current.startswith('@as '):          # how gsettings prints an empty list
    current = current[len('@as '):]
items = ast.literal_eval(current)

if action == 'add' and uuid not in items:
    items.append(uuid)
elif action == 'remove':
    items = [item for item in items if item != uuid]

print('[' + ', '.join(repr(item) for item in items) + ']')

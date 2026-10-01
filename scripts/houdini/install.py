#!/usr/bin/env python3
"""
Install the Koma shelf into Houdini: writes a package file that puts this
folder on HOUDINI_PATH (so toolbar/koma.shelf is found) and tells the shelf
tools where koma_shelf.py is.

    python3 scripts/houdini/install.py            # every Houdini version found
    python3 scripts/houdini/install.py 21.0       # just that one

Then restart Houdini and add the shelf: shelf area > + > Shelves > Koma.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def prefs_root():
    if sys.platform == 'darwin':
        return os.path.expanduser('~/Library/Preferences/houdini')
    if sys.platform.startswith('win'):
        return os.path.join(os.path.expanduser('~'), 'Documents')
    return os.path.expanduser('~')


def version_dirs(only=None):
    root = prefs_root()
    out = []
    for name in sorted(os.listdir(root)):
        version = name[len('houdini'):] if name.startswith('houdini') else name
        if not version[:1].isdigit():
            continue
        if only and version != only:
            continue
        path = os.path.join(root, name)
        if os.path.isdir(path):
            out.append(path)
    return out


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    dirs = version_dirs(only)
    if not dirs:
        sys.exit('No Houdini preferences folder found under %s' % prefs_root())
    package = {
        'hpath': HERE,
        'env': [{'KOMA_HOUDINI': HERE}],
    }
    for d in dirs:
        packages = os.path.join(d, 'packages')
        os.makedirs(packages, exist_ok=True)
        path = os.path.join(packages, 'koma.json')
        with open(path, 'w') as f:
            json.dump(package, f, indent=2)
        print('wrote', path)
    print('Restart Houdini, then add the shelf: shelf area > + > Shelves > Koma')


if __name__ == '__main__':
    main()

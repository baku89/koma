"""
koma_shelf — the functions behind the "Koma" shelf (toolbar/koma.shelf).

Each shelf tool is one call into here; the connection to koma-relay and the
playbar callback live in this module, so they last for the Houdini session.
Settings (relay address, the LED point cloud's node, …) are kept in
$HOUDINI_USER_PREF_DIR/koma_bridge.json.

Install: `python3 scripts/houdini/install.py` writes a Houdini package that
points at this folder; then add the "Koma" shelf from the shelf area's + menu.
"""

import json
import os

import hou

import koma_bridge as kb

_SETTINGS_FILE = os.path.join(hou.homeHoudiniDirectory(), 'koma_bridge.json')
_DEFAULTS = {
    'url': 'ws://localhost:7777',
    'token': '',
    'led_node': '',
    'camera': '',
    'project': '',
}

# The live connection and whether the playbar is being followed.
_state = {'bridge': None, 'key': None, 'following': False}


# -----------------------------------------------------------------------------
# Settings


def settings():
    s = dict(_DEFAULTS)
    try:
        with open(_SETTINGS_FILE) as f:
            s.update(json.load(f))
    except (OSError, ValueError):
        pass
    return s


def save_settings(s):
    with open(_SETTINGS_FILE, 'w') as f:
        json.dump(s, f, indent=2)


def _selected_geo_node():
    """The selected SOP, or the display SOP of a selected geometry object."""
    for n in hou.selectedNodes():
        if isinstance(n, hou.SopNode):
            return n
        if isinstance(n, hou.ObjNode):
            display = getattr(n, 'displayNode', lambda: None)()
            if display is not None:
                return display
    return None


def configure():
    """Ask for the relay address and the nodes; the selection fills in an empty LED node."""
    s = settings()
    if not s['led_node']:
        sel = _selected_geo_node()
        if sel is not None:
            s['led_node'] = sel.path()
    labels = ('Relay URL', 'Token', 'LED node', 'Camera (optional)')
    keys = ('url', 'token', 'led_node', 'camera')
    choice, values = hou.ui.readMultiInput(
        'koma relay and the nodes to send.\n'
        'LED node: the point cloud, one point per pixel in data-line order, with Cd.\n'
        'Camera: sent along while following the playbar (koma moves the rig only\n'
        'with its "Rig" switch on).',
        labels,
        buttons=('OK', 'Cancel'),
        default_choice=0,
        close_choice=1,
        title='Koma Settings',
        initial_contents=tuple(s[k] for k in keys),
    )
    if choice != 0:
        return None
    for k, v in zip(keys, values):
        s[k] = v.strip()
    save_settings(s)
    # A changed address takes effect on the next send.
    _drop_bridge()
    return s


# -----------------------------------------------------------------------------
# Connection and nodes


def _drop_bridge():
    b = _state['bridge']
    if b is not None:
        b.stop_following()
        b.close()
    _state.update(bridge=None, key=None, following=False)


def _bridge(s):
    key = (s['url'], s['token'])
    b = _state['bridge']
    if b is not None and _state['key'] == key and b.connected:
        return b
    following = _state['following']
    _drop_bridge()
    try:
        b = kb.KomaBridge(s['url'], token=s['token'] or None)
    except Exception as e:
        raise hou.Error(
            'Cannot reach koma-relay at %s (%s).\n'
            'Is the relay running, and is the address right? (Koma Settings)' % (s['url'], e)
        )
    _state.update(bridge=b, key=key, following=False)
    if following:
        _start_following(s)
    return b


def _led_node(s):
    """The LED point cloud: the saved node, else the selection (then saved)."""
    node = hou.node(s['led_node']) if s['led_node'] else None
    if node is None:
        node = _selected_geo_node()
        if node is None:
            raise hou.Error(
                'No LED node. Select the LED point cloud (a SOP with Cd on its points)\n'
                'and try again, or set it in Koma Settings.'
            )
        s['led_node'] = node.path()
        save_settings(s)
    geo = node.geometry()
    if geo is None or geo.findPointAttrib('Cd') is None:
        raise hou.Error('%s has no Cd point attribute to send.' % node.path())
    return node


def _status(text, warning=False):
    severity = hou.severityType.Warning if warning else hou.severityType.Message
    try:
        hou.ui.setStatusMessage('koma: ' + text, severity=severity)
    except Exception:
        print('koma:', text)


def _capture_note(b):
    return '' if b.capture_online is not False else ' (koma is not connected to the relay)'


# -----------------------------------------------------------------------------
# Shelf tools


def send_led():
    """Send the LED colours of the current frame, once."""
    s = settings()
    node = _led_node(s)
    b = _bridge(s)
    b.send_led(node.geometry())
    _status('sent %d pixels from %s%s' % (len(node.geometry().points()), node.path(), _capture_note(b)))


def _start_following(s):
    node = _led_node(s)
    b = _state['bridge']
    b.follow_playbar(led_node=node.path(), camera=s['camera'] or None, frame=True)
    _state['following'] = True
    # Show the frame the playbar is on right away.
    b.send_frame(hou.frame())
    b.send_led(node.geometry())
    return node


def toggle_follow():
    """Start / stop sending the LED colours (and the frame number) on every playbar change."""
    s = settings()
    if _state['following'] and _state['bridge'] is not None:
        _state['bridge'].stop_following()
        _state['following'] = False
        _status('live off')
        return False
    b = _bridge(s)
    node = _start_following(s)
    _status('live on — %s follows the playbar%s' % (node.path(), _capture_note(b)))
    return True


def stop():
    """Stop following and disconnect."""
    _drop_bridge()
    _status('disconnected')


def export_set():
    """Write the LED placement to <project>/previz/set.json (once per layout change)."""
    s = settings()
    node = _led_node(s)
    geo = node.geometry()
    missing = [a for a in ('face', 'u') if geo.findPointAttrib(a) is None]
    if 'face' in missing:
        raise hou.Error('%s needs a `face` point attribute (the data line: L1, L2 … F2).' % node.path())
    project = hou.ui.selectFile(
        start_directory=s['project'] or None,
        title='koma project folder',
        file_type=hou.fileType.Directory,
        chooser_mode=hou.fileChooserMode.Read,
    )
    if not project:
        return None
    project = hou.text.expandString(project).rstrip('/')
    if not os.path.isfile(os.path.join(project, 'project.json')):
        raise hou.Error('%s is not a koma project (no project.json).' % project)
    s['project'] = project
    save_settings(s)
    previz = os.path.join(project, 'previz')
    os.makedirs(previz, exist_ok=True)
    path = os.path.join(previz, 'set.json')
    kb.export_set_json(geo, path, image_width=7644, frame='rig', unit='m')
    note = ' — no `u` attribute, the unwrapped image will not map' if 'u' in missing else ''
    _status('wrote %s%s' % (path, note), warning=bool(note))
    return path

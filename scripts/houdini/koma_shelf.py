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
import koma_lens

_SETTINGS_FILE = os.path.join(hou.homeHoudiniDirectory(), 'koma_bridge.json')
_DEFAULTS = {
    'url': 'ws://localhost:7777',
    'token': '',
    'led_node': '',
    'camera': '',
    'project': '',
}

# The live connection and what is being followed live: 'led' (the LED node's
# cooks + the frame number) and/or 'camera' (the camera's pose). One
# event-loop poll serves both (koma_bridge.follow_live).
_state = {'bridge': None, 'key': None, 'following': False, 'led': False, 'camera': False}


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
    _state.update(bridge=None, key=None, following=False, led=False, camera=False)


def _bridge(s):
    key = (s['url'], s['token'])
    b = _state['bridge']
    if b is not None and _state['key'] == key and b.connected:
        return b
    led, camera = _state['led'], _state['camera']
    _drop_bridge()
    try:
        b = kb.KomaBridge(s['url'], token=s['token'] or None)
    except Exception as e:
        raise hou.Error(
            'Cannot reach koma-relay at %s (%s).\n'
            'Is the relay running, and is the address right? (Koma Settings)' % (s['url'], e)
        )
    _state.update(bridge=b, key=key, following=False)
    _state.update(led=led, camera=camera)
    if led or camera:
        _restart_live(s)
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


def _camera_node(s):
    cam = hou.node(s['camera']) if s['camera'] else None
    if cam is None:
        for n in hou.selectedNodes():
            if isinstance(n, hou.ObjNode) and n.type().name() == 'cam':
                cam = n
                break
    if cam is None:
        raise hou.Error(
            'No camera. Select the previz camera object and try again,\n'
            'or set it in Koma Settings.'
        )
    if not s['camera']:
        s['camera'] = cam.path()
        save_settings(s)
    return cam


def _restart_live(s):
    """(Re)start the event-loop poll for whatever is switched on."""
    b = _state['bridge']
    led_node = _led_node(s) if _state['led'] else None
    cam = _camera_node(s) if _state['camera'] else None
    if led_node is None and cam is None:
        b.stop_following()
        _state['following'] = False
        return
    b.follow_live(
        led_node=led_node.path() if led_node else None,
        camera=cam.path() if cam else None,
        frame=_state['led'],
    )
    _state['following'] = True
    # Show what is there right away.
    if led_node is not None:
        b.send_frame(hou.frame())
        b.send_led(led_node.geometry())
    if cam is not None:
        b.send_camera(cam)


def _start_following(s):
    _state['led'] = True
    _restart_live(s)
    return _led_node(s)


def toggle_led_live():
    """
    Start / stop sending the LED colours whenever the LED node cooks (a
    parameter change as much as a new frame) — and the frame number with them.
    In koma: Houdini Live > LED = Live.
    """
    s = settings()
    if _state['led'] and _state['bridge'] is not None:
        _state['led'] = False
        _restart_live(s)
        _status('LED live off')
        return False
    b = _bridge(s)
    _state['led'] = True
    _restart_live(s)
    _status('LED live on — %s follows its cooks%s' % (_led_node(s).path(), _capture_note(b)))
    return True


# The old name (playbar-only following) now means LED live.
toggle_follow = toggle_led_live


def toggle_camera_live():
    """
    Start / stop sending the camera's pose whenever it moves (in the viewport,
    on the playbar, by a parameter). koma moves the Box Rig only while
    Houdini Live > Rig is on there, and only inside the rig limits.
    """
    s = settings()
    if _state['camera'] and _state['bridge'] is not None:
        _state['camera'] = False
        _restart_live(s)
        _status('camera live off')
        return False
    b = _bridge(s)
    cam = _camera_node(s)
    _state['camera'] = True
    _restart_live(s)
    _status('camera live on — koma\'s rig follows %s while its Rig switch is on%s' % (cam.path(), _capture_note(b)))
    return True


def send_plans():
    """
    Write the camera pose (and its focus, when the camera has the Koma Lens
    setup) and the LED wall of every koma frame between koma's in and out
    points into koma's plans, on the layer selected in koma.
    Houdini is evaluated at koma frame + previz frame offset. Existing plans
    on those frames are replaced.
    """
    s = settings()
    b = _bridge(s)
    project = b.state.get('project')
    if not project:
        # The hello carries the latest state; give it a moment if we just connected.
        import time as _t
        for _ in range(20):
            _t.sleep(0.1)
            project = b.state.get('project')
            if project:
                break
    if not project:
        raise hou.Error('koma has not told the relay about its project yet.\nIs koma connected to the relay (title bar)?')
    layer = project.get('currentLayer') or project.get('captureLayer')
    if not layer:
        raise hou.Error('koma has no selected layer.')
    lo, hi = project.get('previewRange') or [0, 0]
    offset = int(project.get('previzFrameOffset') or 0)
    frames = list(range(int(lo), int(hi) + 1))

    led_node = None
    cam = None
    what = []
    try:
        led_node = _led_node(s)
        what.append('LED (%s)' % led_node.path())
    except hou.Error:
        pass
    try:
        cam = _camera_node(s)
        what.append('camera%s (%s)' % (' + focus' if cam.parm('koma_project') is not None else '', cam.path()))
    except hou.Error:
        pass
    if led_node is None and cam is None:
        raise hou.Error('Nothing to send: set the LED node and/or the camera in Koma Settings.')

    choice = hou.ui.displayMessage(
        'Send %s of koma frames %d\u2013%d (%d frames, Houdini frames %d\u2013%d)\n'
        'into koma layer "%s" as plans?\n\nPlans already on those frames are replaced.'
        % (' and '.join(what), lo, hi, len(frames), lo + offset, hi + offset, layer.get('name')),
        buttons=('Send', 'Cancel'),
        default_choice=0,
        close_choice=1,
        title='Koma Send Plans',
    )
    if choice != 0:
        return None

    op = hou.InterruptableOperation('Sending plans to koma', open_interrupt_dialog=True)
    with op:
        def progress(i, n, frame, outcome):
            try:
                op.updateProgress(float(i + 1) / n)
            except hou.OperationInterrupted:
                return False
            return True

        result = b.send_plans(
            frames,
            layer_id=layer['id'],
            led_node=led_node.path() if led_node else None,
            camera=cam.path() if cam else None,
            frame_offset=offset,
            progress=progress,
        )
    failed = result['failed']
    msg = '%d of %d frames set on "%s"' % (len(result['applied']), len(frames), layer.get('name'))
    if failed:
        lines = ['frame %s: %s' % (f, e) for f, e in sorted(failed.items())]
        msg += '\n%d failed:\n' % len(failed) + '\n'.join(lines[:20])
        if len(lines) > 20:
            msg += '\n\u2026'
        hou.ui.displayMessage(msg, severity=hou.severityType.Warning, title='Koma Send Plans')
    _status(msg.split('\n')[0], warning=bool(failed))
    return result


def stop():
    """Stop following and disconnect."""
    _drop_bridge()
    _status('disconnected')


def export_set():
    """Write the LED placement to <project>/previz/set.json (once per layout change)."""
    s = settings()
    node = _led_node(s)
    geo = node.geometry()
    if geo.findPointAttrib('face') is None:
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
    kb.export_set_json(geo, path, frame='rig', unit='m')
    _status('wrote %s' % path)
    return path


def _project_folder(s):
    """Ask for the koma project folder (remembered in the settings)."""
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
    return project


def lens_setup():
    """
    Drive the camera's aperture / focal / focus from the lens table koma
    measured (<project>/calibration.json, koma_lens.py): adds a "Koma Lens"
    folder with the project folder and a focus distance (mm from the head's
    rotation centre) to the camera, with Python expressions on the three
    parameters. Dragging the distance updates the view; koma rewriting the
    file updates it too.
    """
    s = settings()
    cam = _camera_node(s)
    project = s['project']
    if not project or not os.path.isfile(os.path.join(project, koma_lens.CALIBRATION_FILE)):
        project = _project_folder(s)
        if not project:
            return None
    path = os.path.join(project, koma_lens.CALIBRATION_FILE)
    if not os.path.isfile(path):
        raise hou.Error('%s has no %s yet — import the lens measurements in koma (Camera Control > Lens).'
                        % (project, koma_lens.CALIBRATION_FILE))
    # A focus target to aim the lens table at: keep the camera's if it has
    # one, else a null at the origin (the work's bottom centre) that the user
    # moves onto the subject.
    target = cam.evalParm('koma_focus_target') if cam.parm('koma_focus_target') else ''
    if not target or cam.node(target) is None:
        null = hou.node('/obj/focus_target') or hou.node('/obj').createNode('null', 'focus_target')
        target = null.path()
    v = koma_lens.setup(cam, project, target=target)
    _status('%s: focus target %s, focal %.1f mm, aperture %.1f mm, focus %.3f (table %s)'
            % (cam.path(), target, v['focal'], v['aperture'], v['focus'], path))
    return v

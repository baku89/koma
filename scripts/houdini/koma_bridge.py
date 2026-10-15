"""
koma_bridge — drive koma's LED wall / Box Rig / timeline live from Houdini
(ADDSUB.md §13.2), and export the LED placement (previz/set.json).

No dependencies beyond Houdini's Python (a minimal WebSocket client on the
standard library), so it runs inside hython / the Houdini session as is.

Transport: koma-relay's `control` role. Run the relay next to koma
(`yarn relay -- --dir /tmp/koma-exhibit` on the shooting machine, or the
exhibit machine's) and point koma's title-bar relay popup at it; then

    import sys; sys.path.append('/path/to/koma/scripts/houdini')
    import koma_bridge as kb
    bridge = kb.KomaBridge('ws://localhost:7777')      # or koma-exhibit.local

    # LED: the LED point cloud (one point per pixel, points in ws-fanout line
    # order L1 L2 B1 B2 R1 R2 F1 F2, Cd = 0-1 RGB)
    bridge.send_led(hou.node('/obj/LED_box1/OUT').geometry())

    # Camera: the previz camera object (film coordinates = its parent space)
    bridge.send_camera(hou.node('/obj/cam1'))          # frame='film'
    bridge.send_pose([0, 200, 800], angles=dict(tilt=-10, pan=30, roll=0))

    # Timeline: koma's preview follows the playbar
    bridge.send_frame(hou.frame())

    # Everything at once, on every playbar change:
    bridge.follow_playbar(led_node='/obj/LED_box1/OUT', camera='/obj/cam1')
    bridge.stop_following()

    # Live while editing: whenever the LED node cooks (a parameter tweak, a
    # new frame), the camera moves or the frame changes — polled from the
    # event loop, so it needs the Houdini UI (not hython):
    bridge.follow_live(led_node='/obj/LED_box1/OUT', camera='/obj/cam1')

    # Plans: the camera and the wall of koma frames 10…40 into koma's layer
    # (one inbox patch per frame; koma solves the rig axes and records the wall)
    bridge.send_plans(range(10, 41), layer_id='main',
                      led_node='/obj/LED_box1/OUT', camera='/obj/cam1')
    bridge.state['project']   # what koma says: previewRange, currentLayer, …

koma accepts each topic only while its switch in the "Houdini Live" panel is
on (rig follow is off on every launch and refused outside the rig limits or
while the sequence runs).

Export the placement once (koma picks it up from previz/set.json):

    kb.export_set_json(hou.node('/obj/LED_box1/OUT').geometry(),
                       '/path/to/project/previz/set.json',
                       frame='rig', unit='m')

Message formats (JSON, {"type": "control", "topic": …, "data": …}):
  led:frame       {"rgb": <base64 of 3 bytes/pixel, all lines concatenated>,
                   "layoutVersion": 2}
  rig:pose        {"position": [x, y, z], "rotation": [x, y, z, w] |
                   "angles": {"tilt", "pan", "roll"}, "frame": "film"|"world"|"rig",
                   "unit": "mm"|"m"}   or   {"axes": {"x","y","z","a","b","c"}}
  timeline:frame  {"frame": n}     (previz frame numbering)
  inbox           {"id": …, "patch": {"version": 1, "onConflict": …, "ops": […]}}
                  an inbox patch (koma's _inbox/ format); the outcome comes
                  back as the `inbox:result` state with the same id.
"""

import uuid

import base64
import json
import os
import socket
import struct
import threading
import time
from urllib.parse import urlparse

try:
    import hou  # noqa: F401  (only needed for the hou.* helpers)
except ImportError:  # running outside Houdini (tests)
    hou = None


# -----------------------------------------------------------------------------
# Minimal WebSocket client (RFC 6455, client side, text frames, masked)


class _WebSocket:
    def __init__(self, url, timeout=3.0):
        u = urlparse(url)
        if u.scheme not in ('ws', 'wss', 'http', 'https'):
            raise ValueError('url must be ws://host:port')
        if u.scheme in ('wss', 'https'):
            raise ValueError('TLS is not supported by this minimal client')
        host = u.hostname
        port = u.port or 80
        path = u.path or '/'
        if u.query:
            path += '?' + u.query
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            'GET {path} HTTP/1.1\r\n'
            'Host: {host}:{port}\r\n'
            'Upgrade: websocket\r\n'
            'Connection: Upgrade\r\n'
            'Sec-WebSocket-Key: {key}\r\n'
            'Sec-WebSocket-Version: 13\r\n\r\n'
        ).format(path=path, host=host, port=port, key=key)
        self.sock.sendall(req.encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError('handshake: connection closed')
            resp += chunk
        head, _, rest = resp.partition(b'\r\n\r\n')
        status = head.split(b'\r\n', 1)[0]
        if b' 101 ' not in status:
            raise ConnectionError('handshake failed: %s' % status.decode(errors='replace'))
        self._buf = rest
        self.sock.settimeout(None)
        self._lock = threading.Lock()
        self.closed = False
        self.on_text = None
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # -- sending

    def _send_frame(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack('!H', n)
        else:
            header.append(0x80 | 127)
            header += struct.pack('!Q', n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self._lock:
            if self.closed:
                raise ConnectionError('websocket closed')
            self.sock.sendall(bytes(header) + mask + masked)

    def send_text(self, text):
        self._send_frame(0x1, text.encode('utf-8'))

    def close(self):
        if self.closed:
            return
        try:
            self._send_frame(0x8, b'')
        except Exception:
            pass
        self.closed = True
        try:
            self.sock.close()
        except Exception:
            pass

    # -- receiving (only to answer pings; the relay drops silent clients)

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('connection closed')
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _read_loop(self):
        try:
            while not self.closed:
                b0, b1 = self._recv_exact(2)
                opcode = b0 & 0x0F
                n = b1 & 0x7F
                if n == 126:
                    (n,) = struct.unpack('!H', self._recv_exact(2))
                elif n == 127:
                    (n,) = struct.unpack('!Q', self._recv_exact(8))
                payload = self._recv_exact(n)  # server frames are unmasked
                if opcode == 0x9:  # ping → pong
                    self._send_frame(0xA, payload)
                elif opcode == 0x8:
                    self.closed = True
                    break
                elif opcode == 0x1 and self.on_text:
                    try:
                        self.on_text(payload.decode('utf-8'))
                    except Exception:
                        pass
        except Exception:
            self.closed = True


# -----------------------------------------------------------------------------
# Geometry helpers


def led_rgb_bytes(geo, cd_attr='Cd', gamma=1.0):
    """Pack a point cloud's colour into 3 bytes per point, point order."""
    cds = geo.pointFloatAttribValues(cd_attr)
    out = bytearray(len(cds))
    for i, v in enumerate(cds):
        if gamma != 1.0:
            v = v ** gamma if v > 0 else 0.0
        out[i] = 0 if v <= 0 else 255 if v >= 1 else int(v * 255 + 0.5)
    return bytes(out)


def led_lines(geo, line_attr='face'):
    """Group points by data line (the `face` attribute = L1, L2 … F2), in order of first appearance."""
    names = geo.pointStringAttribValues(line_attr)
    order = []
    lines = {}
    for i, name in enumerate(names):
        if name not in lines:
            lines[name] = []
            order.append(name)
        lines[name].append(i)
    return [(name, lines[name]) for name in order]


def export_set_json(geo, path, frame='rig', unit='m', line_attr='face',
                    pitch=None, layout_version=2, geometry=None):
    """
    Write previz/set.json from the LED point cloud: per pixel [x, y, z] in
    data-line order. `frame`/`unit` say what P is in (koma converts); `pitch`
    is in the same unit. Written atomically (tmp + rename).
    """
    pts = geo.points()
    lines = []
    for name, idxs in led_lines(geo, line_attr):
        pixels = []
        for i in idxs:
            p = pts[i].position()
            pixels.append([round(p[0], 5), round(p[1], 5), round(p[2], 5)])
        lines.append({'name': name, 'pixels': pixels})
    led = {
        'layoutVersion': layout_version,
        'frame': frame,
        'unit': unit,
        'lines': lines,
    }
    if pitch is not None:
        led['pitch'] = pitch
    data = {'version': 1, 'led': led}
    if geometry:
        data['geometry'] = geometry
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)
    return data


def camera_pose(cam, unit='m'):
    """
    A Houdini camera's pose in its parent space: position (pupil) and rotation
    as a quaternion [x, y, z, w]. Houdini cameras look down −Z like koma's.
    """
    m = cam.worldTransform()
    t = m.extractTranslates()
    q = hou.Quaternion(m.extractRotationMatrix3())
    return {
        'position': [t[0], t[1], t[2]],
        'rotation': [q[0], q[1], q[2], q[3]],
        'unit': unit,
    }


# -----------------------------------------------------------------------------
# The bridge


class KomaBridge:
    def __init__(self, url='ws://localhost:7777', token=None, layout_version=2):
        base = url.rstrip('/').replace('http://', 'ws://')
        if not base.endswith('/ws'):
            base += '/ws'
        q = 'role=control' + ('&token=' + token if token else '')
        self.url = base + '?' + q
        self.layout_version = layout_version
        self.ws = None
        self.capture_online = None
        self.id = None
        #: Latest state per topic as the relay sends it (`project`, `sequence`, …).
        self.state = {}
        self.on_state = None
        self._results = {}
        self._results_cv = threading.Condition()
        self._callback = None
        self._loop_callback = None
        self.connect()

    def connect(self):
        self.close()
        self.ws = _WebSocket(self.url)
        self.ws.on_text = self._on_text
        return self

    def close(self):
        if self.ws:
            self.ws.close()
            self.ws = None

    @property
    def connected(self):
        return self.ws is not None and not self.ws.closed

    def _on_text(self, text):
        try:
            msg = json.loads(text)
        except ValueError:
            return
        t = msg.get('type')
        if t == 'hello':
            self.capture_online = bool(msg.get('capture'))
            self.id = msg.get('id')
            if isinstance(msg.get('state'), dict):
                self.state.update(msg['state'])
        elif t == 'capture':
            self.capture_online = bool(msg.get('online'))
        elif t == 'state' and isinstance(msg.get('topic'), str):
            self.state[msg['topic']] = msg.get('data')
            if msg['topic'] == 'inbox:result':
                data = msg.get('data') or {}
                with self._results_cv:
                    self._results[str(data.get('id'))] = data
                    self._results_cv.notify_all()
            if self.on_state:
                self.on_state(msg['topic'], msg.get('data'))

    def send(self, topic, data):
        if not self.connected:
            self.connect()
        self.ws.send_text(json.dumps({'type': 'control', 'topic': topic, 'data': data}))

    # -- topics

    def send_led_bytes(self, rgb):
        self.send('led:frame', {
            'rgb': base64.b64encode(rgb).decode('ascii'),
            'layoutVersion': self.layout_version,
        })

    def send_led(self, geo, cd_attr='Cd', gamma=1.0):
        """Light the wall with the point cloud's Cd (points in line order)."""
        self.send_led_bytes(led_rgb_bytes(geo, cd_attr, gamma))

    def send_pose(self, position, rotation=None, angles=None, frame='film', unit='mm'):
        data = {'position': list(position), 'frame': frame, 'unit': unit}
        if rotation is not None:
            data['rotation'] = list(rotation)
        elif angles is not None:
            data['angles'] = dict(angles)
        self.send('rig:pose', data)

    def send_axes(self, x, y, z, a=0.0, b=0.0, c=0.0):
        """Rig machine coordinates directly (mm / degrees)."""
        self.send('rig:pose', {'axes': {'x': x, 'y': y, 'z': z, 'a': a, 'b': b, 'c': c}})

    def send_camera(self, cam, frame='film', unit='m'):
        """Send a camera object's current pose (its world transform, in `frame`)."""
        if isinstance(cam, str):
            cam = hou.node(cam)
        data = camera_pose(cam, unit)
        data['frame'] = frame
        self.send('rig:pose', data)

    def send_frame(self, frame):
        self.send('timeline:frame', {'frame': int(round(frame))})

    # -- inbox patches (koma's _inbox/ format, applied at once over the relay)

    def send_patch(self, ops, on_conflict='overwrite', note='', wait=10.0):
        """
        Apply an inbox patch to the open koma project and return its outcome
        ({'status': 'applied', 'applied': n, …} or {'status': 'rejected',
        'error': …}); None when koma didn't answer within `wait` seconds.
        """
        pid = uuid.uuid4().hex
        patch = {'version': 1, 'note': note, 'onConflict': on_conflict, 'ops': list(ops)}
        with self._results_cv:
            self._results.pop(pid, None)
        self.send('inbox', {'id': pid, 'patch': patch})
        deadline = time.time() + wait
        with self._results_cv:
            while pid not in self._results:
                left = deadline - time.time()
                if left <= 0:
                    return None
                self._results_cv.wait(left)
            return self._results.pop(pid)

    def plan_op(self, layer_id, frame, led_geo=None, camera=None, camera_frame='world',
                unit='m', cd_attr='Cd', gamma=1.0, solve_rig=True):
        """A `setPlan` op for one koma frame from the LED point cloud / camera as they are now."""
        plan = {}
        if camera is not None:
            if isinstance(camera, str):
                camera = hou.node(camera)
            pose = camera_pose(camera, unit)
            pose['frame'] = camera_frame
            plan['camera'] = pose
            if not solve_rig:
                plan['solveRig'] = False
        if led_geo is not None:
            plan['led'] = {'rgb': base64.b64encode(led_rgb_bytes(led_geo, cd_attr, gamma)).decode('ascii')}
        return {'op': 'setPlan', 'layer': layer_id, 'frame': int(frame), 'plan': plan}

    def send_plans(self, koma_frames, layer_id, led_node=None, camera=None,
                   frame_offset=None, camera_frame='world', unit='m',
                   on_conflict='overwrite', progress=None, cd_attr='Cd', gamma=1.0):
        """
        Write the camera pose and/or the wall of every koma frame in
        `koma_frames` into koma's plans on layer `layer_id`, evaluating Houdini
        at frame koma + `frame_offset` (default: koma's previzFrameOffset).
        One patch per frame, so a frame koma refuses (outside the rig limits…)
        doesn't take the others down. `progress(i, n, frame, outcome)` is
        called after each; returns {'applied': [...], 'failed': {frame: error}}.
        Puts the playbar back where it was.
        """
        if led_node is None and camera is None:
            raise ValueError('send_plans needs led_node and/or camera')
        if frame_offset is None:
            frame_offset = int((self.state.get('project') or {}).get('previzFrameOffset') or 0)
        node = hou.node(led_node) if isinstance(led_node, str) else led_node
        frames = list(koma_frames)
        original = hou.frame()
        out = {'applied': [], 'failed': {}}
        try:
            for i, f in enumerate(frames):
                hou.setFrame(f + frame_offset)
                geo = node.geometry() if node is not None else None
                op = self.plan_op(layer_id, f, led_geo=geo, camera=camera,
                                  camera_frame=camera_frame, unit=unit, cd_attr=cd_attr, gamma=gamma)
                outcome = self.send_patch([op], on_conflict=on_conflict,
                                          note='Houdini send_plans frame %d' % f)
                if outcome is None:
                    out['failed'][f] = 'no answer from koma'
                elif outcome.get('status') == 'applied' and outcome.get('applied', 0) > 0:
                    out['applied'].append(f)
                elif outcome.get('status') == 'applied':
                    out['failed'][f] = 'skipped (frame already has a plan)'
                else:
                    out['failed'][f] = outcome.get('error', 'rejected')
                if progress is not None and progress(i, len(frames), f, outcome) is False:
                    break
        finally:
            hou.setFrame(original)
        return out

    # -- live following from the event loop (UI only): cooks, camera moves, frame

    def follow_live(self, led_node=None, camera=None, frame=True, camera_frame='world',
                    unit='m', interval=0.1, force_cook=True):
        """
        Send the LED colours whenever the LED node has (re)cooked — a parameter
        change as much as a new frame — the camera pose whenever it moved, and
        the frame number whenever it changed. Polled from Houdini's event
        loop every `interval` seconds. With `force_cook`, a node that isn't
        displayed is cooked here when it needs to be, so the wall follows
        edits upstream of it even while something else is on screen.
        """
        self.stop_following()
        state = {'t': 0.0, 'cook': None, 'xform': None, 'frame': None}

        def tick():
            now = time.time()
            if now - state['t'] < interval:
                return
            state['t'] = now
            try:
                if frame:
                    f = hou.frame()
                    if f != state['frame']:
                        state['frame'] = f
                        self.send_frame(f)
                if led_node:
                    node = hou.node(led_node) if isinstance(led_node, str) else led_node
                    if node is None:
                        return
                    if force_cook and node.needsToCook():
                        node.cook()
                    count = node.cookCount()
                    if count != state['cook']:
                        state['cook'] = count
                        self.send_led(node.geometry())
                if camera:
                    cam = hou.node(camera) if isinstance(camera, str) else camera
                    if cam is None:
                        return
                    xform = tuple(cam.worldTransform().asTuple())
                    if xform != state['xform']:
                        state['xform'] = xform
                        self.send_camera(cam, camera_frame, unit)
            except Exception as e:  # keep the event loop alive
                print('koma_bridge:', e)

        hou.ui.addEventLoopCallback(tick)
        self._loop_callback = tick
        return tick

    # -- playbar following

    def follow_playbar(self, led_node=None, camera=None, frame=True,
                       camera_frame='film', unit='m', min_interval=0.05):
        """
        On every playbar change, send the LED colours / camera pose / frame
        number. Cooks `led_node` at the new frame. `min_interval` throttles
        scrubbing (the wall latches at ~9 fps anyway).
        """
        self.stop_following()
        state = {'t': 0.0}

        def cb(event_type, frame_no):
            if event_type not in (hou.playbarEvent.FrameChanged, hou.playbarEvent.Stopped):
                return
            now = time.time()
            if event_type == hou.playbarEvent.FrameChanged and now - state['t'] < min_interval:
                return
            state['t'] = now
            try:
                if frame:
                    self.send_frame(frame_no)
                if led_node:
                    node = hou.node(led_node) if isinstance(led_node, str) else led_node
                    self.send_led(node.geometry())
                if camera:
                    self.send_camera(camera, camera_frame, unit)
            except Exception as e:  # keep the playbar alive
                print('koma_bridge:', e)

        hou.playbar.addEventCallback(cb)
        self._callback = cb
        return cb

    def stop_following(self):
        if self._callback:
            try:
                hou.playbar.removeEventCallback(self._callback)
            except Exception:
                pass
            self._callback = None
        if self._loop_callback:
            try:
                hou.ui.removeEventLoopCallback(self._loop_callback)
            except Exception:
                pass
            self._loop_callback = None

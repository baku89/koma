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

koma accepts each topic only while its switch in the "Houdini Live" panel is
on (rig follow is off on every launch and refused outside the rig limits or
while the sequence runs).

Export the placement once (koma picks it up from previz/set.json):

    kb.export_set_json(hou.node('/obj/LED_box1/OUT').geometry(),
                       '/path/to/project/previz/set.json',
                       image_width=7644, frame='rig', unit='m')

Message formats (JSON, {"type": "control", "topic": …, "data": …}):
  led:frame       {"rgb": <base64 of 3 bytes/pixel, all lines concatenated>,
                   "layoutVersion": 1}
  rig:pose        {"position": [x, y, z], "rotation": [x, y, z, w] |
                   "angles": {"tilt", "pan", "roll"}, "frame": "film"|"world"|"rig",
                   "unit": "mm"|"m"}   or   {"axes": {"x","y","z","a","b","c"}}
  timeline:frame  {"frame": n}     (previz frame numbering)
"""

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


def export_set_json(geo, path, image_width, frame='rig', unit='m', u_attr='u',
                    line_attr='face', pitch=None, layout_version=1, geometry=None):
    """
    Write previz/set.json from the LED point cloud: per pixel [x, y, z, u] in
    data-line order. `frame`/`unit` say what P is in (koma converts);
    `image_width` and `pitch` are in the same unit. `u` (horizontal position
    on the unwrapped image) must exist on the points — see the VEX in
    ADDSUB.md §8. Written atomically (tmp + rename).
    """
    pts = geo.points()
    has_u = geo.findPointAttrib(u_attr) is not None
    lines = []
    for name, idxs in led_lines(geo, line_attr):
        pixels = []
        for i in idxs:
            p = pts[i].position()
            u = pts[i].attribValue(u_attr) if has_u else 0.0
            pixels.append([round(p[0], 5), round(p[1], 5), round(p[2], 5), round(u, 5)])
        lines.append({'name': name, 'pixels': pixels})
    led = {
        'layoutVersion': layout_version,
        'frame': frame,
        'unit': unit,
        'imageWidth': image_width,
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
    def __init__(self, url='ws://localhost:7777', token=None, layout_version=1):
        base = url.rstrip('/').replace('http://', 'ws://')
        if not base.endswith('/ws'):
            base += '/ws'
        q = 'role=control' + ('&token=' + token if token else '')
        self.url = base + '?' + q
        self.layout_version = layout_version
        self.ws = None
        self.capture_online = None
        self._callback = None
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
        if msg.get('type') == 'hello':
            self.capture_online = bool(msg.get('capture'))
        elif msg.get('type') == 'capture':
            self.capture_online = bool(msg.get('online'))

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

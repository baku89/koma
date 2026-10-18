"""
The lens table koma measures on the set, for Houdini (ADDSUB.md "レンズ").

koma writes `calibration.json` next to project.json:

    {"version": 1,
     "sensor": {"width": 35.9, "height": 23.93},
     "lens": {"distancesFromPupil": true,
              "table": [{"focus": 0.0, "distance": 300, "focal": 140, "pupil": 90}, ...]}}

Rows are per focus setting of the real lens: `focus` is the camera's
normalised focus position, `distance` where it is focused (mm from the head's
rotation centre along the optical axis), `focal` the pinhole focal length
(mm, what a Houdini camera with `aperture` = sensor width needs) and `pupil`
how far the entrance pupil sits in front of the rotation centre (mm). A
macro lens focused close is far from its nameplate (105 mm reads as 140–200
here), so previz must take the values from the table, not the lens.

Two ways to use it:

    import koma_lens
    table = koma_lens.load('/path/to/project')
    koma_lens.apply(hou.node('/obj/cam'), table, distance_mm=320)

sets `aperture`, `focal` and `focus` once; or `setup(cam, project_dir)`
adds a "Koma Lens" folder (a focus-target object, or a focus distance in mm)
and Python expressions on those three parameters, so moving the camera or
the target refocuses the previz live (the table is re-read when the file
changes).

Houdini's camera origin is the entrance pupil. The rotation centre of the
real head sits `pupil` mm behind it along +Z; koma's IK handles that on the
way to the rig, so previz never needs to place the centre itself.

Plain Python: nothing here needs `hou` except `apply` / `setup`.
"""

import json
import os

CALIBRATION_FILE = 'calibration.json'

_cache = {}


def load(project_dir, use_cache=True):
    """The table rows (sorted by focus) and the sensor size, from the project folder."""
    path = os.path.join(project_dir, CALIBRATION_FILE)
    mtime = os.path.getmtime(path)
    hit = _cache.get(path)
    if use_cache and hit and hit[0] == mtime:
        return hit[1]
    with open(path) as f:
        data = json.load(f)
    rows = sorted(data['lens']['table'], key=lambda r: r['focus'])
    table = {'sensor': data['sensor'], 'rows': rows}
    _cache[path] = (mtime, table)
    return table


def _interp(rows, by, x, key):
    """Piecewise-linear `key` at `x` along `by`, clamped to the ends."""
    if not rows:
        raise ValueError('empty lens table')
    if x <= rows[0][by]:
        return rows[0][key]
    if x >= rows[-1][by]:
        return rows[-1][key]
    for a, b in zip(rows, rows[1:]):
        if x <= b[by]:
            span = b[by] - a[by]
            t = 0.0 if span == 0 else (x - a[by]) / span
            return a[key] + (b[key] - a[key]) * t
    return rows[-1][key]


def at_focus(table, focus):
    """{distance, focal, pupil} at a normalised focus position."""
    rows = table['rows']
    return {k: _interp(rows, 'focus', focus, k) for k in ('distance', 'focal', 'pupil')}


def at_distance(table, distance_mm):
    """{focus, distance, focal, pupil} for a focus plane `distance_mm` from the rotation centre."""
    rows = [r for i, r in enumerate(table['rows']) if i == 0 or r['distance'] > table['rows'][i - 1]['distance']]
    focus = _interp(rows, 'distance', distance_mm, 'focus')
    out = at_focus(table, focus)
    out['focus'] = focus
    return out


def at_pupil_distance(table, pupil_distance_mm):
    """
    {focus, distance, focal, pupil} for a focus plane `pupil_distance_mm` in
    front of the entrance pupil — the distance a Houdini camera (whose origin
    is the pupil) measures. The table is keyed by distance from the head's
    rotation centre, `pupil` further back, so solve the two together (the
    pupil barely moves with focus; three rounds settle it).
    """
    pupil = table['rows'][0]['pupil']
    lens = None
    for _ in range(3):
        lens = at_distance(table, pupil_distance_mm + pupil)
        if abs(lens['pupil'] - pupil) < 1e-6:
            break
        pupil = lens['pupil']
    return lens


def camera_values(table, distance_mm=None, focus=None, unit=0.001, pupil_distance_mm=None):
    """
    What to put on a Houdini camera: `aperture` (mm), `focal` (mm) and `focus`
    (the focus plane's distance from the camera = the pupil, in scene units;
    `unit` is the scene unit per mm: 0.001 for a scene in metres), plus the
    row it came from (`normalized`, `distance`, `pupil`, all as in the table).
    `distance_mm` is from the head's rotation centre (the table's key),
    `pupil_distance_mm` from the entrance pupil (= the Houdini camera).
    """
    if distance_mm is None and focus is None and pupil_distance_mm is None:
        raise ValueError('give distance_mm, pupil_distance_mm or focus')
    if pupil_distance_mm is not None:
        lens = at_pupil_distance(table, pupil_distance_mm)
    elif distance_mm is not None:
        lens = at_distance(table, distance_mm)
    else:
        lens = at_focus(table, focus)
        lens['focus'] = focus
    return {
        'aperture': table['sensor']['width'],
        'focal': lens['focal'],
        'focus': (lens['distance'] - lens['pupil']) * unit,
        'pupil': lens['pupil'],
        'distance': lens['distance'],
        'normalized': lens['focus'],
    }


# -----------------------------------------------------------------------------
# Houdini


def apply(cam, table, distance_mm=None, focus=None, unit=0.001, pupil_distance_mm=None):
    """Set the camera's aperture / focal / focus once (no expressions)."""
    v = camera_values(table, distance_mm, focus, unit, pupil_distance_mm)
    cam.parm('aperture').set(v['aperture'])
    cam.parm('focal').set(v['focal'])
    cam.parm('focus').set(v['focus'])
    return v


def focus_distance_mm(cam):
    """
    How far in front of the camera (its origin = the entrance pupil) the
    focus plane is, mm: the `koma_focus_target` object's position projected
    onto the camera's optical axis (−Z) when one is set, else the
    `koma_focus_mm` parameter. Used by the expressions `setup` installs.
    """
    import hou

    unit = cam.evalParm('koma_unit') or 0.001
    target_path = cam.evalParm('koma_focus_target') if cam.parm('koma_focus_target') else ''
    target = cam.node(target_path) if target_path else None
    if target is None:
        return cam.evalParm('koma_focus_mm')
    cam_xform = cam.worldTransform()
    origin = hou.Vector3(0, 0, 0) * cam_xform
    forward = (hou.Vector3(0, 0, -1) * cam_xform - origin).normalized()
    point = hou.Vector3(0, 0, 0) * target.worldTransform()
    return (point - origin).dot(forward) / unit


_EXPR = {
    'aperture': "return koma_lens.load(hou.pwd().evalParm('koma_project'))['sensor']['width']",
    'focal': "cam = hou.pwd()\n"
             "return koma_lens.camera_values(koma_lens.load(cam.evalParm('koma_project')), "
             "pupil_distance_mm=koma_lens.focus_distance_mm(cam))['focal']",
    'focus': "cam = hou.pwd()\n"
             "return koma_lens.camera_values(koma_lens.load(cam.evalParm('koma_project')), "
             "pupil_distance_mm=koma_lens.focus_distance_mm(cam), unit=cam.evalParm('koma_unit'))['focus']",
}


def setup(cam, project_dir, focus_mm=None, unit=0.001, target=None):
    """
    Give the camera a "Koma Lens" folder — `koma_project`, `koma_unit`,
    `koma_focus_target` (an object whose position is the focus plane, e.g. a
    null on the subject) and `koma_focus_mm` (used when no target is set) —
    and drive `aperture`, `focal` and `focus` from the lens table with Python
    expressions, so moving the camera or the target refocuses the previz
    like the rig would. Re-running updates the folder and keeps the rest.
    """
    import hou

    group = cam.parmTemplateGroup()
    if group.find('koma_focus_target') is None:
        old = group.find('koma_lens')
        if old is not None:
            group.remove(old)
        folder = hou.FolderParmTemplate('koma_lens', 'Koma Lens', folder_type=hou.folderType.Simple)
        folder.addParmTemplate(hou.StringParmTemplate(
            'koma_project', 'Project folder', 1,
            string_type=hou.stringParmType.FileReference,
            file_type=hou.fileType.Directory,
            help='The koma project folder holding calibration.json'))
        folder.addParmTemplate(hou.StringParmTemplate(
            'koma_focus_target', 'Focus target', 1,
            string_type=hou.stringParmType.NodeReference,
            tags={'opfilter': '!!OBJ!!', 'oprelative': '.'},
            help='Object (e.g. a null) whose position sets the focus plane: its distance along '
                 'the optical axis picks the focal length and focus from the lens table'))
        folder.addParmTemplate(hou.FloatParmTemplate(
            'koma_focus_mm', 'Focus distance (mm)', 1, default_value=(300,),
            min=0, max=2000, help='Focus plane in front of the camera (the entrance pupil), '
                                  'used when no focus target is set'))
        folder.addParmTemplate(hou.FloatParmTemplate(
            'koma_unit', 'Scene unit (per mm)', 1, default_value=(0.001,), min=0, max=1,
            help='0.001 for a scene in metres, 1 for millimetres'))
        group.append(folder)
        cam.setParmTemplateGroup(group)
    cam.parm('koma_project').set(project_dir)
    cam.parm('koma_unit').set(unit)
    if focus_mm is not None:
        cam.parm('koma_focus_mm').set(focus_mm)
    if target is not None:
        cam.parm('koma_focus_target').set(target if isinstance(target, str) else cam.relativePathTo(target))
    prelude = ("import sys, hou\n"
               "p = hou.getenv('KOMA_HOUDINI')\n"
               "if p and p not in sys.path: sys.path.append(p)\n"
               "import koma_lens\n")
    for name, body in _EXPR.items():
        cam.parm(name).setExpression(prelude + body, language=hou.exprLanguage.Python)
    return camera_values(load(project_dir), pupil_distance_mm=focus_distance_mm(cam), unit=unit)

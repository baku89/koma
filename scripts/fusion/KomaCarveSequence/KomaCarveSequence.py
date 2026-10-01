"""
KomaCarveSequence — per-frame difference toolpaths from an STL sequence.

Frame N's G-code removes only what differs between frame N-1 and frame N:
a copy of the *template setup* is made per frame with

    model = frame N's mesh,  stock = frame N-1's mesh

and its Parallel operation, which must have Rest Machining on with the source
"From setup stock", then only cuts where that stock stands above the model.

Prepare one template setup by hand (Manufacture workspace):
  - a Parallel operation with the tool, feeds and stepover you want;
    Geometry > Rest Machining on, Source = From setup stock.
  - WCS origin at a FIXED place (model origin or a selected point) — not a
    stock / model box point: the stock changes every frame, so a box-point
    origin would move with it.
  - one NC program in the document that already posts with your post
    processor (its post and post properties are reused).
Then edit the settings below and run this script (Utilities > Scripts and
Add-Ins). Re-running reuses the meshes and setups it made before.

Output: OUT_DIR/<sequence name>_<frame>.nc per frame and carve_sequence.log.
"""

import glob
import os
import re
import time
import traceback

import adsk.cam
import adsk.core
import adsk.fusion

# ------------------------------------------------------------------------------
# Settings

STL_DIR = '/Users/baku/Dropbox/Works/2024/10_addsub/stl/261001_carve_test'
OUT_DIR = '/Users/baku/Dropbox/Works/2024/10_addsub/nc/261001_carve_test'
# The files are written in metres.
MESH_UNITS = adsk.fusion.MeshUnits.MeterMeshUnit
# Setup to copy. '' = the active setup, else the first one with a Parallel.
TEMPLATE_SETUP = ''
# (first, last) frame numbers to make, inclusive; None = every frame after the first file.
FRAMES = None
# False = build the setups and toolpaths only (look at them before posting).
POST = True
# Strategy of the operation that cuts the difference.
STRATEGY = 'parallel'

SETUP_PREFIX = 'carve '

# ------------------------------------------------------------------------------


def frame_number(path):
    m = re.search(r'(\d+)\.stl$', os.path.basename(path), re.IGNORECASE)
    return int(m.group(1)) if m else None


def find_ops(setup, strategy):
    return [op for op in setup.allOperations if getattr(op, 'strategy', None) == strategy]


def by_name(items, name):
    """The item called `name`, or None. (`itemByName` raises when there is none.)"""
    for item in items:
        if item.name == name:
            return item
    return None


def param(obj, name):
    """A CAM parameter of a setup / operation, or None if it has no such parameter."""
    try:
        return obj.parameters.itemByName(name)
    except RuntimeError:
        return None


def param_expression(obj, name):
    p = param(obj, name)
    return p.expression if p else None


def text_of(op, attr):
    """An operation's error / warning text on one line ('' if it has none)."""
    try:
        return (getattr(op, attr) or '').replace('\n', ' ')
    except RuntimeError:
        return ''


def collection(*items):
    c = adsk.core.ObjectCollection.create()
    for item in items:
        c.add(item)
    return c


def wait_for(future, progress, label):
    """Pump the UI until the toolpaths are generated. False if cancelled."""
    while not future.isGenerationCompleted:
        if progress.wasCancelled:
            return False
        progress.message = label
        adsk.doEvents()
        time.sleep(0.05)
    return True


def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    log = []

    def note(text):
        log.append(text)

    try:
        doc = app.activeDocument
        design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
        cam = adsk.cam.CAM.cast(doc.products.itemByProductType('CAMProductType'))
        if not design or not cam:
            ui.messageBox('Open the document with the template setup first (it needs a Manufacture setup).')
            return

        # -- the sequence
        files = sorted(
            (f for f in glob.glob(os.path.join(STL_DIR, '*.stl')) if frame_number(f) is not None),
            key=frame_number,
        )
        if len(files) < 2:
            ui.messageBox('Need at least two STL files in\n%s' % STL_DIR)
            return
        sequence = re.sub(r'[._-]?\d+\.stl$', '', os.path.basename(files[0]), flags=re.IGNORECASE)
        by_frame = {frame_number(f): f for f in files}
        frames = sorted(by_frame)
        targets = [f for f in frames[1:] if FRAMES is None or FRAMES[0] <= f <= FRAMES[1]]
        if not targets:
            ui.messageBox('No frames to make in %s (FRAMES = %s)' % (STL_DIR, FRAMES))
            return

        # -- the template
        setups = [s for s in cam.setups]
        template = None
        if TEMPLATE_SETUP:
            template = by_name(cam.setups, TEMPLATE_SETUP)
            if not template:
                ui.messageBox('No setup named "%s"' % TEMPLATE_SETUP)
                return
        else:
            candidates = [s for s in setups if not s.name.startswith(SETUP_PREFIX) and find_ops(s, STRATEGY)]
            template = next((s for s in candidates if s.isActive), candidates[0] if candidates else None)
        if not template or not find_ops(template, STRATEGY):
            ui.messageBox('No setup with a "%s" operation to use as the template.' % STRATEGY)
            return
        template_op = find_ops(template, STRATEGY)[0]

        warnings = []
        rest = param(template_op, 'useRestMachining')
        if not rest or not rest.value.value:
            warnings.append(
                '"%s" has Rest Machining off: every frame would re-cut the whole surface.\n'
                'Turn it on (Geometry tab) with Source = From setup stock.' % template_op.name
            )
        origin_mode = param_expression(template, 'wcs_origin_mode') or ''
        if 'stock' in origin_mode.lower() or 'modelpoint' in origin_mode.lower().replace("'", ''):
            warnings.append(
                'The setup\'s WCS origin is a box point (%s). The stock changes every frame,\n'
                'so the origin would move with it. Use the model origin or a selected point.' % origin_mode
            )
        post_source = None
        if POST:
            for nc in cam.ncPrograms:
                try:
                    if nc.postConfiguration:
                        post_source = nc
                        break
                except Exception:
                    pass
            if not post_source:
                warnings.append(
                    'No NC program in this document to take the post processor from.\n'
                    'Post one operation by hand once (or set POST = False).'
                )

        question = (
            'Sequence: %s  (%d files)\n'
            'Frames to make: %d  (%04d - %04d)\n'
            'Template: setup "%s" / operation "%s"\n'
            'Rest material source: %s\n'
            'Output: %s\n'
        ) % (
            sequence, len(files), len(targets), targets[0], targets[-1],
            template.name, template_op.name,
            param_expression(template_op, 'restMaterialSource'),
            OUT_DIR if POST else '(not posting)',
        )
        if warnings:
            question += '\nWARNING\n' + '\n\n'.join(warnings) + '\n'
        question += '\nGo on?'
        answer = ui.messageBox(
            question, 'Koma Carve Sequence',
            adsk.core.MessageBoxButtonTypes.YesNoButtonType,
            adsk.core.MessageBoxIconTypes.WarningIconType if warnings else adsk.core.MessageBoxIconTypes.QuestionIconType,
        )
        if answer != adsk.core.DialogResults.DialogYes:
            return
        note('sequence %s, template "%s" / "%s"' % (sequence, template.name, template_op.name))
        note('restMaterialSource = %s, wcs_origin_mode = %s' % (
            param_expression(template_op, 'restMaterialSource'), origin_mode))
        for w in warnings:
            note('WARNING ' + w.replace('\n', ' '))

        # -- meshes (reused by name on a re-run)
        root = design.rootComponent
        needed = sorted({f for t in targets for f in (frames[frames.index(t) - 1], t)})
        meshes = {}
        for body in root.meshBodies:
            meshes[body.name] = body
        missing = [f for f in needed if ('%s_%04d' % (sequence, f)) not in meshes]
        if missing:
            ui.workspaces.itemById('FusionSolidEnvironment').activate()
            base = None
            if design.designType == adsk.fusion.DesignTypes.ParametricDesignType:
                base = root.features.baseFeatures.add()
                base.startEdit()
            try:
                for f in missing:
                    added = root.meshBodies.add(by_frame[f], MESH_UNITS, base) if base else \
                        root.meshBodies.add(by_frame[f], MESH_UNITS)
                    if added.count != 1:
                        raise RuntimeError('%s: expected one mesh, got %d' % (by_frame[f], added.count))
                    body = added.item(0)
                    body.name = '%s_%04d' % (sequence, f)
                    body.isLightBulbOn = False
                    adsk.doEvents()
            finally:
                if base:
                    base.finishEdit()
            meshes = {body.name: body for body in root.meshBodies}
            note('imported %d meshes' % len(missing))
        ui.workspaces.itemById('CAMEnvironment').activate()
        adsk.doEvents()

        # -- one setup per frame
        os.makedirs(OUT_DIR, exist_ok=True)
        progress = ui.createProgressDialog()
        progress.isCancelButtonShown = True
        progress.show('Koma Carve Sequence', 'Starting…', 0, len(targets))
        made = 0
        skipped = 0
        for i, frame in enumerate(targets):
            if progress.wasCancelled:
                note('cancelled at frame %04d' % frame)
                break
            previous = frames[frames.index(frame) - 1]
            name = '%s%04d' % (SETUP_PREFIX, frame)
            label = 'Frame %04d  (%d / %d)' % (frame, i + 1, len(targets))
            progress.message = label
            progress.progressValue = i
            adsk.doEvents()

            setup = by_name(cam.setups, name)
            if not setup:
                before = {s.operationId for s in cam.setups}
                template.duplicate()
                setup = next((s for s in cam.setups if s.operationId not in before), None)
                if not setup:
                    raise RuntimeError('Could not duplicate the template setup')
                setup.name = name
                # Keep only the operation that cuts the difference.
                for op in [op for op in setup.allOperations]:
                    if getattr(op, 'strategy', None) != STRATEGY:
                        op.deleteMe()
            ops = find_ops(setup, STRATEGY)
            if not ops:
                raise RuntimeError('Setup "%s" has no %s operation' % (name, STRATEGY))
            op = ops[0]

            setup.models = collection(meshes['%s_%04d' % (sequence, frame)])
            setup.stockMode = adsk.cam.SetupStockModes.SolidStock
            setup.stockSolids = collection(meshes['%s_%04d' % (sequence, previous)])

            future = cam.generateToolpath(setup)
            if not wait_for(future, progress, label + ' — generating'):
                note('cancelled at frame %04d' % frame)
                break

            if op.hasError or not op.hasToolpath:
                # Nothing to cut between two identical frames ends up here too.
                skipped += 1
                note('%04d  no toolpath  %s' % (frame, text_of(op, 'error') or text_of(op, 'warning')))
                continue
            seconds = None
            try:
                # feed scale in %, rapid in cm/s (1500 mm/min)
                seconds = cam.getMachiningTime(op, 100.0, 2.5, 0.0).machiningTime
            except Exception:
                pass
            line = '%04d  ok' % frame
            if seconds is not None:
                line += '  %.0f s' % seconds
            if op.hasWarning:
                line += '  warning: ' + text_of(op, 'warning')

            if POST and post_source:
                filename = '%s_%04d' % (sequence, frame)
                existing = by_name(cam.ncPrograms, name)
                if existing:
                    existing.deleteMe()
                nc_input = cam.ncPrograms.createInput()
                nc_input.displayName = name
                params = nc_input.parameters
                params.itemByName('nc_program_filename').value.value = filename
                params.itemByName('nc_program_openInEditor').value.value = False
                params.itemByName('nc_program_output_folder').value.value = OUT_DIR
                nc_input.operations = [op]
                nc = cam.ncPrograms.add(nc_input)
                nc.postConfiguration = post_source.postConfiguration
                nc.updatePostParameters(post_source.postParameters)
                if nc.postProcess(adsk.cam.NCProgramPostProcessOptions.create()):
                    line += '  -> %s' % filename
                else:
                    line += '  POST FAILED'
            made += 1
            note(line)

        progress.hide()
        summary = '%d frames made, %d without a toolpath.' % (made, skipped)
        note(summary)
        ui.messageBox(summary + ('\n\nG-code and log: %s' % OUT_DIR if POST else ''), 'Koma Carve Sequence')
    except Exception:
        note(traceback.format_exc())
        if ui:
            ui.messageBox('Failed:\n%s' % traceback.format_exc())
    finally:
        # A run that was declined at the dialog leaves the previous log alone.
        if log:
            try:
                os.makedirs(OUT_DIR, exist_ok=True)
                with open(os.path.join(OUT_DIR, 'carve_sequence.log'), 'w') as f:
                    f.write('\n'.join(log) + '\n')
            except Exception:
                pass

"""PathFinder hot-path call counter.

The extension (src/hotPath.ts) puts this folder first on PYTHONPATH of a Python debug launch,
so Python imports this module at interpreter startup, before debugpy and the user's program.
It never touches the user's code: it counts every call of every function defined under the
workspace roots with sys.monitoring (Python 3.12+), and keeps <PATHFINDER_HOT_DIR>/<pid>.json
up to date with the totals so the extension can read them while the program runs.

debugpy owns sys.settrace (it refuses other tracers), and uses sys.monitoring's DEBUGGER_ID,
so this uses the separate PROFILER_ID tool slot and does not interfere with breakpoints.

Everything is wrapped so a failure here can never break the user's program.
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_DUMP_INTERVAL = 0.25  # seconds between snapshots written for the extension


def _chain_original_sitecustomize():
    """We shadow any sitecustomize the environment already had; run it too, as Python would have."""
    import importlib.machinery
    import importlib.util

    search = [p for p in sys.path if os.path.abspath(p or os.getcwd()) != _HERE]
    spec = importlib.machinery.PathFinder.find_spec('sitecustomize', search)
    if spec is None or spec.loader is None:
        return
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def _install(out_dir, roots_env):
    import atexit
    import json
    import threading
    import time

    pid = os.getpid()
    out_file = os.path.join(out_dir, '%d.json' % pid)

    def write(payload):
        os.makedirs(out_dir, exist_ok=True)
        tmp = out_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        os.replace(tmp, out_file)  # atomic: the extension never sees a half-written file

    if sys.version_info < (3, 12):
        write({'pid': pid, 'error': 'hot-path counting needs Python 3.12+ (found %d.%d)' % sys.version_info[:2]})
        return

    monitoring = sys.monitoring
    tool = monitoring.PROFILER_ID
    try:
        monitoring.use_tool_id(tool, 'pathfinder-hot')
    except ValueError:
        write({'pid': pid, 'error': 'sys.monitoring PROFILER_ID is already in use'})
        return

    roots = [os.path.normcase(os.path.abspath(r)).rstrip(os.sep) + os.sep
             for r in roots_env.split(os.pathsep) if r]
    this_file = os.path.normcase(os.path.abspath(__file__))
    DISABLE = monitoring.DISABLE

    codes = {}       # id(code) -> code, for every counted code object (the ref keeps the id unique)
    per_thread = []  # one {id(code): count} dict per thread, so threads never race on a counter
    local = threading.local()

    def wanted(code):
        name = code.co_name
        # Comprehensions/lambdas/genexprs are their own code objects; they aren't graph nodes.
        if name.startswith('<') and name != '<module>':
            return False
        filename = code.co_filename
        if not filename or filename.startswith('<'):
            return False
        filename = os.path.normcase(os.path.abspath(filename))
        return filename != this_file and any(filename.startswith(root) for root in roots)

    def on_start(code, offset):
        # PY_START fires once per real call (not on generator/coroutine resumes).
        key = id(code)
        if key not in codes:
            if not wanted(code):
                return DISABLE  # never called back for this code object again
            codes[key] = code
        try:
            counts = local.counts
        except AttributeError:
            counts = local.counts = {}
            per_thread.append(counts)
        counts[key] = counts.get(key, 0) + 1

    def snapshot():
        totals = {}
        for counts in list(per_thread):
            for key, n in counts.copy().items():
                totals[key] = totals.get(key, 0) + n
        functions = []
        for key, n in totals.items():
            code = codes[key]
            lines = [line for _, _, line in code.co_lines() if line is not None]
            functions.append({
                'file': os.path.abspath(code.co_filename),
                'qualname': code.co_qualname,
                'line': code.co_firstlineno,  # first decorator line for decorated functions
                'endLine': max(lines, default=code.co_firstlineno),
                'count': n,
            })
        return totals, functions

    last = [None]

    def dump():
        totals, functions = snapshot()
        if totals == last[0]:
            return
        write({'pid': pid, 'functions': functions})
        last[0] = totals

    def dump_loop():
        while True:
            time.sleep(_DUMP_INTERVAL)
            try:
                dump()
            except Exception:
                pass  # e.g. the extension is reading the file on Windows; try again next tick

    def final_dump():
        for _ in range(5):
            try:
                dump()
                return
            except Exception:
                time.sleep(0.05)

    monitoring.register_callback(tool, monitoring.events.PY_START, on_start)
    monitoring.set_events(tool, monitoring.events.PY_START)

    thread = threading.Thread(target=dump_loop, name='pathfinder-hot-dump', daemon=True)
    thread.pydev_do_not_trace = True      # tell debugpy not to trace or suspend this thread
    thread.is_pydev_daemon_thread = True
    thread.start()
    atexit.register(final_dump)


try:
    _chain_original_sitecustomize()
except Exception:
    import traceback
    traceback.print_exc()

try:
    _out_dir = os.environ.get('PATHFINDER_HOT_DIR')
    _roots = os.environ.get('PATHFINDER_HOT_ROOTS')
    if _out_dir and _roots:
        _install(_out_dir, _roots)
except Exception:
    pass
finally:
    # Leave sys.path as the user's program expects it.
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.getcwd()) != _HERE]

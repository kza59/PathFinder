"""PathFinder hot-path call counter for C/C++ (gdb). The gdb counterpart of python/pathfinder_hot/sitecustomize.py.

Loaded into gdb with `source`, then started with:  pathfinder-hot <OUT_DIR> <ROOT>[:<ROOT>...]
It never changes the program: every function with debug info whose source file is under one of the roots gets
a breakpoint that counts the call and lets the program carry on without stopping. Totals are written to
<OUT_DIR>/<pid>.json in the same format as the Python hook, so the extension maps them onto graph nodes the
same way:  {"pid": ..., "functions": [{"file", "qualname", "line", "endLine", "count"}]}

Each counted call is a trip through gdb (microseconds), so a function called millions of times in a tight loop
makes the program noticeably slower. Everything is wrapped so a failure here can never break the debug session.
"""

import json
import os
import re
import threading
import time

import gdb

_DUMP_INTERVAL = 0.25  # seconds between snapshots written for the extension
_SYSTEM_DIRS = ('/usr/', '/lib/', '/lib32/', '/lib64/', '/libx32/', '/System/')

# `info functions -q -n` output: "File recursion.c:" headers, then "29:\tint countdown(int);" lines.
_FILE_RE = re.compile(r'^File (.+):$')
_FUNCTION_RE = re.compile(r'^(\d+):\s+(.+?);?$')


def _function_name(signature):
    """'void Dog::speak() const' -> 'Dog::speak'; 'static char *name(int)' -> 'name'."""
    head = signature.split('(', 1)[0].strip()
    return head.split()[-1].lstrip('*&') if head else signature


class _CountingBreakpoint(gdb.Breakpoint):
    def __init__(self, session, key, path, line, name):
        # By function (within its file): fires exactly once per call. A line breakpoint can land in several
        # places when the function's first line also holds a loop, e.g. `int main(void) { for (...) ... }`.
        try:
            super().__init__(source=path, function=name, internal=True)
        except gdb.error:
            super().__init__(source=path, line=line, internal=True)  # names gdb can't parse (some templates)
        self.silent = True
        self._session = session
        self._key = key

    def stop(self):
        self._session.hit(self._key)
        return False  # never actually stop the program


class _Session:
    def __init__(self, out_dir, roots):
        self.out_dir = out_dir
        self.roots = [os.path.normcase(os.path.abspath(r)).rstrip(os.sep) + os.sep for r in roots]
        self.paths = {}       # source name as gdb lists it -> absolute workspace path, or None if not ours
        self.functions = {}   # (path, line) -> {"file", "qualname", "line", "endLine"}
        self.counts = {}      # (path, line) -> calls
        self.breakpoints = []
        self.pid = None
        self.last_written = None
        self.lock = threading.Lock()

    def under_roots(self, path):
        # Must really exist: libraries' debug info can carry relative paths (glibc's "elf/dl-load.c") that gdb
        # resolves against the current directory, which is often the workspace.
        path = os.path.normcase(os.path.abspath(path))
        return any(path.startswith(root) for root in self.roots) and os.path.isfile(path)

    def resolve(self, name, line):
        """Absolute path of a source file as named in `info functions`, or None if it isn't a workspace file."""
        if name not in self.paths:
            try:
                sals = gdb.decode_line('%s:%d' % (name, line))[1] or []
                path = sals[0].symtab.fullname() if sals and sals[0].symtab else None
            except gdb.error:
                path = None
            self.paths[name] = path if path and self.under_roots(path) else None
        return self.paths[name]

    def scan(self, event=None):
        """Adds a counting breakpoint to every workspace function gdb knows about that isn't counted yet."""
        objfile = getattr(event, 'new_objfile', None)
        name = getattr(objfile, 'filename', None) or ''
        if objfile is not None and (name.startswith(_SYSTEM_DIRS) or not os.path.isabs(name)):
            return  # system libraries (libc, the loader, vdso) can't hold workspace code; rescanning them is slow
        try:
            listing = gdb.execute('info functions -q -n', to_string=True)
        except gdb.error:
            return
        current = None
        skip = False
        for raw in listing.splitlines():
            line = raw.rstrip()
            header = _FILE_RE.match(line)
            if header:
                current, skip = header.group(1), self.paths.get(header.group(1), '') is None
                continue
            match = _FUNCTION_RE.match(line.strip())
            if skip or not current or not match:
                continue
            number, signature = int(match.group(1)), match.group(2)
            path = self.resolve(current, number)  # once per file, not per function
            if not path:
                skip = True
                continue
            key = (path, number)
            if key in self.functions:
                continue
            name = _function_name(signature)
            try:
                self.breakpoints.append(_CountingBreakpoint(self, key, path, number, name))
            except gdb.error:
                continue
            self.functions[key] = {'file': path, 'qualname': name, 'line': number, 'endLine': number}

    def hit(self, key):
        if self.pid is None:
            self.pid = gdb.selected_inferior().pid
        with self.lock:
            self.counts[key] = self.counts.get(key, 0) + 1

    def payload(self):
        with self.lock:
            counts = dict(self.counts)
        functions = [dict(self.functions[key], count=n) for key, n in counts.items()]
        return counts, {'pid': self.pid or os.getpid(), 'functions': functions}

    def dump(self):
        counts, payload = self.payload()
        if not counts or counts == self.last_written:
            return  # nothing counted yet (the program may not have started), or nothing new
        os.makedirs(self.out_dir, exist_ok=True)
        out_file = os.path.join(self.out_dir, '%d.json' % payload['pid'])
        tmp = out_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        os.replace(tmp, out_file)  # atomic: the extension never sees a half-written file
        self.last_written = counts

    def dump_loop(self):
        while True:
            time.sleep(_DUMP_INTERVAL)
            try:
                self.dump()
            except Exception:
                pass  # e.g. the extension is reading the file on Windows; try again next tick

    def final_dump(self, _event=None):
        try:
            self.dump()
        except Exception:
            pass

    def start(self):
        gdb.events.new_objfile.connect(self.scan)  # the program (and its shared libraries) can load later
        gdb.events.exited.connect(self.final_dump)
        if hasattr(gdb.events, 'gdb_exiting'):
            gdb.events.gdb_exiting.connect(self.final_dump)
        self.scan()
        threading.Thread(target=self.dump_loop, name='pathfinder-hot-dump', daemon=True).start()


class _Command(gdb.Command):
    """Count calls to workspace functions: pathfinder-hot OUT_DIR ROOT[:ROOT...]"""

    def __init__(self):
        super().__init__('pathfinder-hot', gdb.COMMAND_USER)

    def invoke(self, argument, from_tty):
        args = gdb.string_to_argv(argument)
        if len(args) < 2:
            raise gdb.GdbError('usage: pathfinder-hot OUT_DIR ROOT[:ROOT...]')
        try:
            _Session(args[0], [r for r in args[1].split(os.pathsep) if r]).start()
        except Exception as error:  # never break the debug session
            gdb.write('pathfinder-hot: disabled (%s)\n' % error)


_Command()

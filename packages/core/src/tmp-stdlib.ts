export * as TmpStdlib from "./tmp-stdlib.js"

import { Effect } from "effect"

// Top-level module names of the Python standard library. A stray `<name>.py` file
// in a directory Python processes start from shadows the stdlib module of the same
// name, because the script directory (cwd) precedes the stdlib on `sys.path`.
// Sourced from `sys.stdlib_module_names` (leading-underscore and dotted names omitted).
const STDLIB = new Set([
  "abc",
  "annotationlib",
  "antigravity",
  "argparse",
  "array",
  "ast",
  "asyncio",
  "atexit",
  "base64",
  "bdb",
  "binascii",
  "bisect",
  "builtins",
  "bz2",
  "cProfile",
  "calendar",
  "cmath",
  "cmd",
  "code",
  "codecs",
  "codeop",
  "collections",
  "colorsys",
  "compileall",
  "compression",
  "concurrent",
  "configparser",
  "contextlib",
  "contextvars",
  "copy",
  "copyreg",
  "csv",
  "ctypes",
  "curses",
  "dataclasses",
  "datetime",
  "dbm",
  "decimal",
  "difflib",
  "dis",
  "doctest",
  "email",
  "encodings",
  "ensurepip",
  "enum",
  "errno",
  "faulthandler",
  "fcntl",
  "filecmp",
  "fileinput",
  "fnmatch",
  "fractions",
  "ftplib",
  "functools",
  "gc",
  "genericpath",
  "getopt",
  "getpass",
  "gettext",
  "glob",
  "graphlib",
  "grp",
  "gzip",
  "hashlib",
  "heapq",
  "hmac",
  "html",
  "http",
  "idlelib",
  "imaplib",
  "importlib",
  "inspect",
  "io",
  "ipaddress",
  "itertools",
  "json",
  "keyword",
  "linecache",
  "locale",
  "logging",
  "lzma",
  "mailbox",
  "marshal",
  "math",
  "mimetypes",
  "mmap",
  "modulefinder",
  "msvcrt",
  "multiprocessing",
  "netrc",
  "nt",
  "ntpath",
  "nturl2path",
  "numbers",
  "opcode",
  "operator",
  "optparse",
  "os",
  "pathlib",
  "pdb",
  "pickle",
  "pickletools",
  "pkgutil",
  "platform",
  "plistlib",
  "poplib",
  "posix",
  "posixpath",
  "pprint",
  "profile",
  "pstats",
  "pty",
  "pwd",
  "py_compile",
  "pyclbr",
  "pydoc",
  "pydoc_data",
  "pyexpat",
  "queue",
  "quopri",
  "random",
  "re",
  "readline",
  "reprlib",
  "resource",
  "rlcompleter",
  "runpy",
  "sched",
  "secrets",
  "select",
  "selectors",
  "shelve",
  "shlex",
  "shutil",
  "signal",
  "site",
  "smtplib",
  "socket",
  "socketserver",
  "sqlite3",
  "sre_compile",
  "sre_constants",
  "sre_parse",
  "ssl",
  "stat",
  "statistics",
  "string",
  "stringprep",
  "struct",
  "subprocess",
  "symtable",
  "sys",
  "sysconfig",
  "syslog",
  "tabnanny",
  "tarfile",
  "tempfile",
  "termios",
  "textwrap",
  "this",
  "threading",
  "time",
  "timeit",
  "tkinter",
  "token",
  "tokenize",
  "tomllib",
  "trace",
  "traceback",
  "tracemalloc",
  "tty",
  "turtle",
  "turtledemo",
  "types",
  "typing",
  "unicodedata",
  "unittest",
  "urllib",
  "uuid",
  "venv",
  "warnings",
  "wave",
  "weakref",
  "webbrowser",
  "winreg",
  "winsound",
  "wsgiref",
  "xml",
  "xmlrpc",
  "zipapp",
  "zipfile",
  "zipimport",
  "zlib",
  "zoneinfo",
])

// True for a top-level file name that would shadow a stdlib module.
// Directories and nested paths never match: the sweep is top level only.
export function isStdlibPyFile(name: string): boolean {
  if (!name.endsWith(".py")) return false
  const stem = name.slice(0, -".py".length)
  if (stem.length === 0 || stem.includes("/") || stem.includes("\\")) return false
  return STDLIB.has(stem)
}

// Sorted stdlib-shadow file names among top-level directory entries.
export function findShadows(names: Iterable<string>): string[] {
  return Array.from(names).filter(isStdlibPyFile).sort()
}

// Warning text naming the offending files and the `python3 -I` workaround.
export function messageFor(tmp: string, files: ReadonlyArray<string>): string {
  const listed = files.map((file) => `  - ${file}`).join("\n")
  return [
    `Stdlib shadow in the opencode tmp root ${tmp}:`,
    listed,
    "A top-level .py file named after a Python standard library module shadows that module for any Python process started with this directory as cwd (cwd precedes the stdlib on sys.path), so e.g. `import re` would load the stray file instead. Nothing was changed: the file may belong to another project. Run Python from this directory with `python3 -I`, which skips cwd on sys.path, or rename/remove the file if it is yours.",
  ].join("\n")
}

// Top-level sweep of the tmp root. Never recursive, never deletes, moves, or
// edits anything. Resolves to the shadow file names, or [] when quiet (clean
// root, missing directory, unreadable directory).
export const scan = Effect.fn("TmpStdlib.scan")(function* (tmp: string) {
  const { readdir } = yield* Effect.promise(() => import("fs/promises"))
  return yield* Effect.tryPromise(() => readdir(tmp, { withFileTypes: true })).pipe(
    Effect.map((entries) => findShadows(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))),
    Effect.orElseSucceed(() => [] as string[]),
  )
})

const warned = new Set<string>()

// Warn once per tmp root per process through the Effect log surface.
// Never fails and never touches files.
export const checkOnce = Effect.fn("TmpStdlib.checkOnce")(function* (tmp: string) {
  if (warned.has(tmp)) return
  const shadows = yield* scan(tmp)
  if (shadows.length === 0) return
  warned.add(tmp)
  yield* Effect.logWarning(messageFor(tmp, shadows))
})

// Test hook resetting the once-per-process warn state.
export const resetWarned = (): void => {
  warned.clear()
}

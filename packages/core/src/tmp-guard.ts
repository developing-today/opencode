export * as TmpGuard from "./tmp-guard.js"

import fs from "node:fs"
import { Effect } from "effect"

// Python standard-library top-level module names (CPython 3.14;
// underscore-prefixed private internals omitted). A `<name>.py` file in a
// directory that sits first on sys.path — the working directory of a
// `python3` invocation, or a directory on PYTHONPATH — shadows the standard
// library module of the same name. The shared tmp root is exactly such a
// directory: shells and agents are directed to work from it, so one stray
// `re.py` there breaks every Python run with a misleading traceback (#132).
const stdlib = new Set([
  "abc",
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

export function isStdlibPythonFile(name: string): boolean {
  if (!name.endsWith(".py")) return false
  return stdlib.has(name.slice(0, -3))
}

export function findCollisions(names: ReadonlyArray<string>): Array<string> {
  return names.filter(isStdlibPythonFile).toSorted()
}

// Top level only: that is what lands on sys.path for a process started in
// the directory. Files are never deleted, moved, or modified — they may
// belong to another project that shares the tmp root.
export function scan(directory: string): Array<string> {
  return findCollisions(
    fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  )
}

export function warning(directory: string, files: ReadonlyArray<string>): string {
  return [
    `Python standard-library shadowing risk in the shared tmp directory ${directory}:`,
    `${files.join(", ")} shadow${files.length === 1 ? "s" : ""} the Python standard library`,
    "for any python3 process started from that directory.",
    "Run python3 -I (isolated mode) to ignore the directory, or move/rename the file.",
    "The file was left untouched; it may belong to another project.",
  ].join(" ")
}

const warned = new Set<string>()

// Warn once per process per (directory, collision set); the scan itself is
// a single top-level directory listing, cheap enough for session start.
export const warn = Effect.fn("TmpGuard.warn")(function* (directory: string) {
  const files = yield* Effect.try(() => scan(directory)).pipe(Effect.orElseSucceed(() => [] as Array<string>))
  if (files.length === 0) return files
  const key = `${directory}\n${files.join(",")}`
  if (warned.has(key)) return files
  warned.add(key)
  yield* Effect.logWarning(warning(directory, files))
  return files
})

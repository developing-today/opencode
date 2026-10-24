import { dlopen, FFIType } from "bun:ffi"

// The systemd roles a test plays without systemd: a supervisor that owns a listening socket and never accepts
// on it, and a notify socket that captures what a server sends to $NOTIFY_SOCKET. Both are libc calls because
// Bun exposes neither a socket it will not accept on nor a unix datagram receiver.

const AF_INET = 2
const AF_UNIX = 1
const SOCK_STREAM = 1
const SOCK_DGRAM = 2
const SOL_SOCKET = 1
const SO_REUSEADDR = 2
const MSG_DONTWAIT = 0x40

// Loaded on first use, not at import: the tests that import this fixture gate themselves by platform
// (test.skip on Windows, where libc.so.6 does not exist), but a top-level dlopen runs before any skip
// is consulted and fails the whole file at load. Production code does the same lazy load in
// src/systemd-datagram.bun.ts.
let loaded: ReturnType<typeof loadSymbols> | undefined

function loadSymbols() {
  return dlopen("libc.so.6", {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64_fast, FFIType.i32], returns: FFIType.i64_fast },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  }).symbols
}

function symbols() {
  loaded ??= loadSymbols()
  return loaded
}

// A TCP listener on 127.0.0.1, bound to an ephemeral port and listening. The caller owns the descriptor.
export function listenSocket(): { readonly fd: number; readonly port: number } {
  const fd = symbols().socket(AF_INET, SOCK_STREAM, 0)
  if (fd < 0) throw new Error("socket failed")
  symbols().setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, new Int32Array([1]), 4)
  const address = new Uint8Array(16)
  address[0] = AF_INET
  address[4] = 127
  address[7] = 1
  if (symbols().bind(fd, address, 16) !== 0) throw new Error("bind failed")
  if (symbols().listen(fd, 128) !== 0) throw new Error("listen failed")
  const bound = new Uint8Array(16)
  const length = new Uint32Array([16])
  if (symbols().getsockname(fd, bound, length) !== 0) throw new Error("getsockname failed")
  return { fd, port: (bound[2]! << 8) | bound[3]! }
}

export function closeSocket(fd: number) {
  symbols().close(fd)
}

// A bound unix datagram socket. A leading '@' names an abstract socket, as NOTIFY_SOCKET may.
// `next` returns the next datagram, or undefined if none arrives in time.
export function datagramReceiver(name: string) {
  const fd = symbols().socket(AF_UNIX, SOCK_DGRAM, 0)
  if (fd < 0) throw new Error("socket failed")
  const abstract = name.startsWith("@")
  const bytes = new TextEncoder().encode(abstract ? name.slice(1) : name)
  const address = new Uint8Array(2 + (abstract ? 1 : 0) + bytes.length + (abstract ? 0 : 1))
  new DataView(address.buffer).setUint16(0, AF_UNIX, true)
  address.set(bytes, abstract ? 3 : 2)
  if (symbols().bind(fd, address, address.length) !== 0) throw new Error(`bind ${name} failed`)
  return {
    async next(timeoutMs = 5_000): Promise<string | undefined> {
      const buffer = new Uint8Array(256)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const received = symbols().recv(fd, buffer, buffer.length, MSG_DONTWAIT)
        if (received >= 0) return new TextDecoder().decode(buffer.subarray(0, Number(received)))
        await Bun.sleep(10)
      }
      return undefined
    },
    close() {
      symbols().close(fd)
    },
  }
}

// Bun has no unix datagram socket, so READY=1 goes out through libc's sendto(2), the same datagram sd_notify(3) uses.

import { dlopen, FFIType } from "bun:ffi"

const AF_UNIX = 1
const SOCK_DGRAM = 2
const SOCK_CLOEXEC = 0o2000000
const SUN_PATH_MAX = 108

const libcSymbols = {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  sendto: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64_fast, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i64_fast,
  },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
} as const

export async function sendReady(socket: string): Promise<void> {
  // Linux only; NOTIFY_SOCKET is only set by systemd, which is Linux-only.
  if (process.platform !== "linux") return
  const { symbols } = dlopen("libc.so.6", libcSymbols)
  const fd = symbols.socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0)
  if (fd < 0) throw new Error(`notify ${socket}: could not create a datagram socket`)
  try {
    const address = unixAddress(socket)
    const message = new TextEncoder().encode("READY=1")
    const sent = symbols.sendto(fd, message, message.length, 0, address, address.length)
    if (sent < 0) throw new Error(`notify ${socket}: sendto failed`)
  } finally {
    symbols.close(fd)
  }
}

// A leading '@' names an abstract socket: the path bytes start with NUL and carry no terminator.
function unixAddress(socket: string): Uint8Array {
  const abstract = socket.startsWith("@")
  const name = new TextEncoder().encode(abstract ? socket.slice(1) : socket)
  const path = abstract ? [0, ...name] : [...name, 0]
  if (path.length > SUN_PATH_MAX) throw new Error(`notify socket name too long: ${socket}`)
  const address = new Uint8Array(2 + path.length)
  new DataView(address.buffer).setUint16(0, AF_UNIX, true)
  address.set(path, 2)
  return address
}

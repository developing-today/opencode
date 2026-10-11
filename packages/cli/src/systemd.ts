// The systemd conventions a supervisor uses to hand over and watch `serve`: socket activation (sd_listen_fds(3))
// and Type=notify readiness (sd_notify(3)). Both are plain environment variables and a datagram socket.

import { sendReady } from "#systemd-datagram"

const INHERITED_LISTEN_FD = 3

// systemd passes the listening socket as fd 3 and names the process that owns it in LISTEN_PID.
export function inheritedListenFd(env: Record<string, string | undefined>, pid: number): number | undefined {
  if (env.LISTEN_PID !== String(pid)) return undefined
  const count = Number.parseInt(env.LISTEN_FDS ?? "", 10)
  return Number.isInteger(count) && count >= 1 ? INHERITED_LISTEN_FD : undefined
}

// Outside a Type=notify unit NOTIFY_SOCKET is unset and this does nothing.
export async function notifyReady(env: Record<string, string | undefined> = process.env): Promise<void> {
  const socket = env.NOTIFY_SOCKET
  if (!socket) return
  await sendReady(socket)
}

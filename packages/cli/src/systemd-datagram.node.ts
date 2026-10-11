// Node has no unix datagram socket, so READY=1 goes through systemd-notify, which reads NOTIFY_SOCKET itself.

import { execFile } from "node:child_process"

export function sendReady(socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("systemd-notify", ["--ready"], { env: { ...process.env, NOTIFY_SOCKET: socket } }, (error) => {
      if (error) reject(new Error(`notify ${socket}: ${error.message}`))
      else resolve()
    })
  })
}

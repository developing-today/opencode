import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inheritedListenFd, notifyReady } from "../src/systemd"
import { datagramReceiver } from "./fixture/systemd-socket"

test("a listening socket is taken only by the process LISTEN_PID names", () => {
  expect(inheritedListenFd({ LISTEN_PID: "42", LISTEN_FDS: "1" }, 42)).toBe(3)
  expect(inheritedListenFd({ LISTEN_PID: "42", LISTEN_FDS: "2" }, 42)).toBe(3)
  expect(inheritedListenFd({ LISTEN_PID: "41", LISTEN_FDS: "1" }, 42)).toBeUndefined()
  expect(inheritedListenFd({ LISTEN_PID: "42", LISTEN_FDS: "0" }, 42)).toBeUndefined()
  expect(inheritedListenFd({ LISTEN_PID: "42", LISTEN_FDS: "many" }, 42)).toBeUndefined()
  expect(inheritedListenFd({ LISTEN_FDS: "1" }, 42)).toBeUndefined()
  expect(inheritedListenFd({}, 42)).toBeUndefined()
})

const notifyTest = process.platform === "linux" ? test : test.skip

notifyTest("READY=1 reaches a unix datagram notify socket", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-notify-"))
  const socket = path.join(dir, "notify.sock")
  const receiver = datagramReceiver(socket)
  try {
    await notifyReady({ NOTIFY_SOCKET: socket })
    expect(await receiver.next()).toBe("READY=1")
  } finally {
    receiver.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

notifyTest("READY=1 reaches an abstract notify socket", async () => {
  const name = `@opencode-notify-${process.pid}-${Date.now()}`
  const receiver = datagramReceiver(name)
  try {
    await notifyReady({ NOTIFY_SOCKET: name })
    expect(await receiver.next()).toBe("READY=1")
  } finally {
    receiver.close()
  }
})

notifyTest("notify reports a socket nobody listens on", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-notify-"))
  try {
    await expect(notifyReady({ NOTIFY_SOCKET: path.join(dir, "absent.sock") })).rejects.toThrow("sendto failed")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("notify is a no-op outside systemd", async () => {
  await expect(notifyReady({})).resolves.toBeUndefined()
})

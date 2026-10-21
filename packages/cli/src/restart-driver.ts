import { Effect } from "effect"
import { ServerProcess } from "./server-process"
import { NodeRuntime } from "@effect/platform-node"
// OC_PORT comes from supervisor/unit configuration: accept only a decimal integer in port range and
// fall back to the default otherwise, instead of handing NaN, a fraction, or 0 (empty value) to the bind.
const parsedPort = process.env.OC_PORT !== undefined && /^\d+$/.test(process.env.OC_PORT.trim()) ? Number(process.env.OC_PORT) : NaN
const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 4096
if (process.env.OC_PORT !== undefined && port !== parsedPort)
  console.warn(`Ignoring invalid OC_PORT=${JSON.stringify(process.env.OC_PORT)}; using port ${port}`)
NodeRuntime.runMain(ServerProcess.run({ mode: "default", hostname: "127.0.0.1", port }) as Effect.Effect<unknown, unknown, never>)

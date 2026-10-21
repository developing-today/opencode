import { Effect } from "effect"
import { ServerProcess } from "./server-process"
import { NodeRuntime } from "@effect/platform-node"
import { parsePortEnv } from "./restart-port"

const parsed = parsePortEnv(process.env.OC_PORT)
if (parsed.invalid)
  console.warn(`Ignoring invalid OC_PORT=${JSON.stringify(process.env.OC_PORT)}; using port ${parsed.port}`)
NodeRuntime.runMain(
  ServerProcess.run({ mode: "default", hostname: "127.0.0.1", port: parsed.port }) as Effect.Effect<
    unknown,
    unknown,
    never
  >,
)

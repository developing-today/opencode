import { Effect } from "effect"
import { ServerProcess } from "./server-process"
import { NodeRuntime } from "@effect/platform-node"
const port = Number(process.env.OC_PORT ?? "4096")
NodeRuntime.runMain(ServerProcess.run({ mode: "default", hostname: "127.0.0.1", port }) as Effect.Effect<unknown, unknown, never>)

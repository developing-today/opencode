import { describe, expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { GitHubFiles } from "../src/files.js"
import { GitHubProcess } from "../src/process.js"
import { it } from "./lib"

const context: Tool.Context = {
  sessionID: Session.ID.make("ses_files"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_files"),
  id: Tool.CallID.make("call_files"),
  progress: () => Effect.void,
}

const make = () => {
  const asserted: Array<{ action: string; resources: ReadonlyArray<string> }> = []
  const files = GitHubFiles.make({
    location: new Location.Info({
      directory: AbsolutePath.make("/work/repo/packages/app"),
      project: {
        id: Project.ID.global,
        directory: AbsolutePath.make("/work/repo"),
        canonical: AbsolutePath.make("/work/repo"),
      },
    }),
    permission: {
      assert: (input) => Effect.sync(() => void asserted.push({ action: input.action, resources: input.resources })),
    },
  })
  return { files, asserted }
}

describe("GitHubFiles", () => {
  it.live("paths in the project are relative resources and need no external approval", () =>
    Effect.gen(function* () {
      const { files, asserted } = make()
      const sibling = yield* files.resolve({ path: "../lib/shot.png", kind: "file" })
      expect(sibling).toEqual({ absolute: "/work/repo/packages/lib/shot.png", resource: "../lib/shot.png" })
      yield* files.authorizeRead("assets/shot.png", context)
      expect(asserted).toEqual([{ action: "read", resources: ["assets/shot.png"] }])
    }),
  )

  it.live("paths outside the project need external-directory approval for their directory first", () =>
    Effect.gen(function* () {
      const { files, asserted } = make()
      const file = yield* files.authorizeRead("/tmp/out/shot.png", context)
      expect(file).toEqual({ absolute: "/tmp/out/shot.png", resource: "/tmp/out/shot.png", external: "/tmp/out" })
      const directory = yield* files.resolve({ path: "/tmp/downloads", kind: "directory" })
      yield* files.authorizeExternal([directory], context)
      expect(asserted).toEqual([
        { action: "external_directory", resources: ["/tmp/out/*"] },
        { action: "read", resources: ["/tmp/out/shot.png"] },
        { action: "external_directory", resources: ["/tmp/downloads/*"] },
      ])
    }),
  )
})

describe("GitHubProcess.run", () => {
  it.live("returns output and exit codes without failing, including for a missing program", () =>
    Effect.gen(function* () {
      const ok = yield* GitHubProcess.run("git", ["--version"])
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout).toStartWith("git version")
      const missing = yield* GitHubProcess.run("opencode-no-such-program", [])
      expect(missing.exitCode).toBe(127)
      expect(missing.stderr).toContain("opencode-no-such-program")
    }),
  )
})

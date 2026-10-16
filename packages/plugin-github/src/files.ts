export * as GitHubFiles from "./files.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import os from "node:os"
import path from "node:path"

export interface Target {
  readonly absolute: string
  /** Relative to the working directory inside the project, absolute outside it. */
  readonly resource: string
  /** Set outside the project: the directory whose `external_directory` approval covers the target. */
  readonly external?: string
}

/** Approvals for local files, using the same permission actions as the read and write tools. */
export interface Interface {
  readonly resolve: (input: { readonly path: string; readonly kind?: "file" | "directory" }) => Effect.Effect<Target>
  readonly authorizeExternal: (targets: ReadonlyArray<Target>, context: Tool.Context) => Effect.Effect<void, Tool.Error>
  readonly authorizeRead: (file: string, context: Tool.Context) => Effect.Effect<Target, Tool.Error>
}

export function make(input: {
  readonly location: Context["location"]
  readonly permission: Pick<Context["permission"], "assert">
}): Interface {
  const directory = input.location.directory
  const project = path.resolve(input.location.project.directory)
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }
  const source = (context: Tool.Context) => ({
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool" as const, messageID: context.messageID, id: context.id },
  })
  const resolve: Interface["resolve"] = (target) =>
    Effect.sync(() => {
      const expanded =
        target.path === "~"
          ? os.homedir()
          : target.path.startsWith("~/")
            ? path.join(os.homedir(), target.path.slice(2))
            : target.path
      const absolute = path.resolve(directory, expanded)
      const internal =
        inside(directory, absolute) || (project !== path.parse(project).root && inside(project, absolute))
      if (internal) return { absolute, resource: (path.relative(directory, absolute) || ".").replaceAll("\\", "/") }
      return {
        absolute,
        resource: absolute.replaceAll("\\", "/"),
        external: target.kind === "directory" ? absolute : path.dirname(absolute),
      }
    })
  const authorizeExternal: Interface["authorizeExternal"] = (targets, context) => {
    const resources = Array.from(
      new Set(targets.flatMap((target) => (target.external ? [`${target.external.replaceAll("\\", "/")}/*`] : []))),
    )
    if (resources.length === 0) return Effect.void
    return input.permission.assert({ action: "external_directory", resources, save: resources, ...source(context) })
  }
  return {
    resolve,
    authorizeExternal,
    authorizeRead: (file, context) =>
      Effect.gen(function* () {
        const target = yield* resolve({ path: file, kind: "file" })
        yield* authorizeExternal([target], context)
        yield* input.permission.assert({
          action: "read",
          resources: [target.resource],
          save: ["*"],
          ...source(context),
        })
        return target
      }),
  }
}

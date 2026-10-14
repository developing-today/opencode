export * as PlanInfoPlugin from "./plan-info.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Permission } from "../permission.js"
import { PlanInfoTool } from "../tool/plugin/plan-info.js"

/** The plan store is useful with or without routes, so its tool is always offered. */
export const Plugin = define({
  id: "opencode.plan-info",
  effect: Effect.fn(function* (ctx) {
    const permission = yield* Permission.Service
    yield* ctx.tool.transform((editor) => {
      PlanInfoTool.add(editor, permission)
    })
  }),
})

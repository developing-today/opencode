export * as GitHubExplore from "./explore.js"

import type { Tool } from "@opencode/schema/tool"
import type { GitHubShared } from "./shared.js"

export function tools(_deps: GitHubShared.Deps): Tool.Info[] {
  return []
}

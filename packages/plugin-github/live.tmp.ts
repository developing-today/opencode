import { Effect, Layer, Context, Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { GitHubTools } from "./src/index.ts"
import { GitHubClient } from "./src/client.ts"
import { GitHubFiles } from "./src/files.ts"
import { GitHubProcess } from "./src/process.ts"
const scope = Effect.runSync(Scope.make())
const services = await Effect.runPromise(Layer.build(FetchHttpClient.layer).pipe(Scope.provide(scope)))
const store = new Map()
const permission = { assert: () => Effect.die("no writes in this check") } as any
const tools = GitHubTools.tools({
  client: GitHubClient.make({ http: Context.get(services, HttpClient.HttpClient), run: GitHubProcess.run }),
  run: GitHubProcess.run,
  kv: { get: (k: string) => Effect.sync(() => store.get(k)), set: (k: string, v: any) => Effect.sync(() => void store.set(k, v)), remove: () => Effect.void, scan: () => Effect.succeed({ entries: [] }) } as any,
  permission,
  sessions: { synthetic: () => Effect.void } as any,
  files: GitHubFiles.make({ location: { directory: process.cwd(), project: { directory: process.cwd() } } as any, permission }),
  scope, directory: process.cwd(), codemode: true,
})
const ctx = { sessionID: "ses_x", agent: "build", messageID: "msg_x", id: "call_x", progress: () => Effect.void } as any
const call = (name: string, input: any) => Effect.runPromise(tools.find((t) => t.name === name)!.execute(input, ctx) as any).then((r: any) => r.output, (e: any) => ({ error: String(e?.message ?? e).slice(0, 400) }))
const repos = JSON.parse(process.argv[2])
for (const repo of repos) {
  console.log("=====", repo)
  const vars = await call("variables", { repo })
  console.log("variables:", vars.error ?? JSON.stringify(vars.variables.map((v: any) => `${v.scope}${v.environment ? ":" + v.environment : ""}${v.org ? ":" + v.org : ""}/${v.name}`)), JSON.stringify(vars.notes))
  const secrets = await call("secrets", { repo })
  console.log("secrets:", secrets.error ?? JSON.stringify(secrets.secrets.map((v: any) => `${v.scope}${v.environment ? ":" + v.environment : ""}/${v.name}`)), JSON.stringify(secrets.notes))
  const envs = await call("environments", { repo })
  console.log("environments:", envs.error ?? JSON.stringify(envs.environments.map((e: any) => ({ name: e.name, reviewers: e.reviewers?.length, wait: e.wait_timer, policy: e.deployment_branch_policy, counts: e.counts }))).slice(0, 1200), JSON.stringify(envs.notes ?? []))
  const rules = await call("rulesets", { repo })
  console.log("rulesets:", rules.error ?? JSON.stringify(rules).slice(0, 900))
  const branch = await call("rulesets", { repo, branch: "main" })
  console.log("branch rules:", branch.error ?? JSON.stringify(branch).slice(0, 600))
  const protection = await call("branch_protection", { repo })
  console.log("protection:", protection.error ?? JSON.stringify(protection).slice(0, 900))
}
process.exit(0)

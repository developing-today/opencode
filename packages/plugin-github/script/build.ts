#!/usr/bin/env bun

import { $ } from "bun"
import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.chdir(fileURLToPath(new URL("..", import.meta.url)))

await rm("dist", { recursive: true, force: true })
// tsc writes the declarations; Bun writes the JavaScript and inlines the Markdown skill, which Node cannot import.
await $`bun tsc -p tsconfig.build.json`
const root = path.resolve("src")
const files = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: root, absolute: true }))
const result = await Bun.build({
  entrypoints: files.filter((file) => !file.endsWith(".d.ts")),
  root,
  outdir: "dist",
  target: "node",
  format: "esm",
  packages: "external",
  splitting: true,
  loader: { ".md": "text" },
  naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
})
if (!result.success) throw new AggregateError(result.logs, "Failed to build the GitHub plugin")

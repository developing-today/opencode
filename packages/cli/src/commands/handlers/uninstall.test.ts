import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, readlink, readdir, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../../test/fixture/tmpdir"
import { cleanShellConfig, writeShellConfig } from "./uninstall"

describe("cleanShellConfig", () => {
  test("removes the opencode PATH entry and its marker line", () => {
    const content = ["# opencode", 'export PATH="$HOME/.opencode/bin:$PATH"', "alias ll='ls -l'", ""].join("\n")
    expect(cleanShellConfig(content)).toBe(["alias ll='ls -l'", ""].join("\n"))
  })

  test("removes a fish_add_path entry", () => {
    const content = ["fish_add_path $HOME/.opencode/bin", "set -g theme dark", ""].join("\n")
    expect(cleanShellConfig(content)).toBe(["set -g theme dark", ""].join("\n"))
  })

  test("keeps unrelated PATH lines and a marker not followed by an entry", () => {
    const content = ["# opencode", "# a hand-written note", 'export PATH="$HOME/.local/bin:$PATH"', ""].join("\n")
    expect(cleanShellConfig(content)).toBe(content)
  })

  test("leaves content without an opencode entry unchanged", () => {
    const content = ["export EDITOR=vim", ""].join("\n")
    expect(cleanShellConfig(content)).toBe(content)
  })
})

describe("writeShellConfig", () => {
  const write = (file: string, content: string) =>
    Effect.runPromise(writeShellConfig(file, content).pipe(Effect.provide(NodeFileSystem.layer)))

  test("replaces a regular file's content and keeps its mode", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, ".bashrc")
    await writeFile(file, "old\n")
    await chmod(file, 0o640)

    await write(file, "new\n")

    expect(await readFile(file, "utf8")).toBe("new\n")
    expect((await stat(file)).mode & 0o777).toBe(0o640)
    expect(await readdir(directory.path)).toEqual([".bashrc"])
  })

  test("writes through a symlink to its target and keeps the target's mode", async () => {
    await using directory = await tmpdir()
    const target = path.join(directory.path, "dotfiles", "bashrc")
    const link = path.join(directory.path, ".bashrc")
    await mkdir(path.join(directory.path, "dotfiles"))
    await writeFile(target, "old\n")
    await chmod(target, 0o600)
    await symlink(target, link)

    await write(link, "new\n")

    expect(await readlink(link)).toBe(target)
    expect(await readFile(target, "utf8")).toBe("new\n")
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect((await readdir(path.join(directory.path, "dotfiles"))).sort()).toEqual(["bashrc"])
  })
})

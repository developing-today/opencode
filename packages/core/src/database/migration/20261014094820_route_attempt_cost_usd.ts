import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261014094820_route_attempt_cost_usd",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`cost_usd\` real;`)
    })
  },
}

export default migration

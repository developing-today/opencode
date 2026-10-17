import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261016221426_messaging",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`messaging_message\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`topic_id\` integer NOT NULL,
          \`seq\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`type\` text NOT NULL,
          \`writer\` text NOT NULL,
          \`data\` text NOT NULL,
          \`meta\` text,
          \`reply\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_messaging_message_topic_id_messaging_topic_id_fk\` FOREIGN KEY (\`topic_id\`) REFERENCES \`messaging_topic\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messaging_participant\` (
          \`topic_id\` integer NOT NULL,
          \`session_id\` text NOT NULL,
          \`reads\` integer DEFAULT 0 NOT NULL,
          \`writes\` integer DEFAULT 0 NOT NULL,
          \`last_read_seq\` integer DEFAULT 0 NOT NULL,
          \`time_first_read\` integer,
          \`time_last_read\` integer,
          \`time_first_write\` integer,
          \`time_last_write\` integer,
          CONSTRAINT \`messaging_participant_pk\` PRIMARY KEY(\`topic_id\`, \`session_id\`),
          CONSTRAINT \`fk_messaging_participant_topic_id_messaging_topic_id_fk\` FOREIGN KEY (\`topic_id\`) REFERENCES \`messaging_topic\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messaging_subscription\` (
          \`topic_id\` integer NOT NULL,
          \`session_id\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`messaging_subscription_pk\` PRIMARY KEY(\`topic_id\`, \`session_id\`),
          CONSTRAINT \`fk_messaging_subscription_topic_id_messaging_topic_id_fk\` FOREIGN KEY (\`topic_id\`) REFERENCES \`messaging_topic\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messaging_topic\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`name\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`preset\` text,
          \`owner\` text,
          \`creator\` text NOT NULL,
          \`description\` text,
          \`mode\` text,
          \`writers\` text,
          \`last_seq\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_last\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messaging_var\` (
          \`scope\` text NOT NULL,
          \`name\` text NOT NULL,
          \`value\` text NOT NULL,
          \`by\` text NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`messaging_var_pk\` PRIMARY KEY(\`scope\`, \`name\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messaging_vector\` (
          \`source\` text NOT NULL,
          \`key\` text NOT NULL,
          \`model\` text NOT NULL,
          \`hash\` text NOT NULL,
          \`dimensions\` integer NOT NULL,
          \`vector\` blob NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`messaging_vector_pk\` PRIMARY KEY(\`source\`, \`key\`, \`model\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messaging_visibility\` (
          \`topic_id\` integer NOT NULL,
          \`seq\` integer NOT NULL,
          \`viewer\` text NOT NULL,
          \`hidden\` integer NOT NULL,
          \`by\` text NOT NULL,
          \`op_seq\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`messaging_visibility_pk\` PRIMARY KEY(\`topic_id\`, \`seq\`, \`viewer\`),
          CONSTRAINT \`fk_messaging_visibility_topic_id_messaging_topic_id_fk\` FOREIGN KEY (\`topic_id\`) REFERENCES \`messaging_topic\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`messaging_message_topic_seq_idx\` ON \`messaging_message\` (\`topic_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`messaging_message_topic_kind_seq_idx\` ON \`messaging_message\` (\`topic_id\`,\`kind\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`messaging_message_writer_time_idx\` ON \`messaging_message\` (\`writer\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`messaging_message_time_created_idx\` ON \`messaging_message\` (\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`messaging_participant_session_write_idx\` ON \`messaging_participant\` (\`session_id\`,\`time_last_write\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`messaging_participant_session_read_idx\` ON \`messaging_participant\` (\`session_id\`,\`time_last_read\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`messaging_subscription_session_idx\` ON \`messaging_subscription\` (\`session_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`messaging_topic_name_idx\` ON \`messaging_topic\` (\`name\`);`)
      yield* tx.run(`CREATE INDEX \`messaging_topic_kind_idx\` ON \`messaging_topic\` (\`kind\`);`)
      yield* tx.run(`CREATE INDEX \`messaging_topic_owner_idx\` ON \`messaging_topic\` (\`owner\`);`)
      yield* tx.run(`CREATE INDEX \`messaging_topic_time_created_idx\` ON \`messaging_topic\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`messaging_topic_time_last_idx\` ON \`messaging_topic\` (\`time_last\`);`)
      yield* tx.run(
        `CREATE INDEX \`messaging_vector_model_source_idx\` ON \`messaging_vector\` (\`model\`,\`source\`);`,
      )
      yield* tx.run(`CREATE INDEX \`messaging_visibility_viewer_idx\` ON \`messaging_visibility\` (\`viewer\`);`)
      yield* tx.run(
        `CREATE INDEX \`messaging_visibility_by_idx\` ON \`messaging_visibility\` (\`by\`,\`time_updated\`);`,
      )
    })
  },
}

export default migration

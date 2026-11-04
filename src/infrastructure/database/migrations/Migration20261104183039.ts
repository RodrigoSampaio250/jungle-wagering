import { Migration } from "@mikro-orm/migrations";

export class Migration20261104183039 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "event_type" varchar(100) NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL,
        "published_at" timestamptz NULL,
        "attempts" int NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NOT NULL,
        "last_error" text NULL,

        CONSTRAINT "outbox_events_pkey"
          PRIMARY KEY ("id"),

        CONSTRAINT "outbox_attempts_nonnegative"
          CHECK (attempts >= 0),

        CONSTRAINT "outbox_aggregate_event_unique"
          UNIQUE ("aggregate_id", "event_type")
      );
    `);

    this.addSql(`
      CREATE INDEX "outbox_publish_idx"
      ON "outbox_events" (
        "published_at",
        "next_attempt_at",
        "created_at"
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE "outbox_events";`);
  }
}
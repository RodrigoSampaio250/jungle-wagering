import { Migration } from "@mikro-orm/migrations";

export class Migration20261104204311 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE "inbox_messages" (
        "id" uuid NOT NULL,
        "consumer_name" varchar(100) NOT NULL,
        "message_id" varchar(200) NOT NULL,
        "payload_hash" varchar(64) NOT NULL,
        "processed_at" timestamptz NOT NULL,

        CONSTRAINT "inbox_messages_pkey"
          PRIMARY KEY ("id"),

        CONSTRAINT "inbox_consumer_message_unique"
          UNIQUE ("consumer_name", "message_id")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE "inbox_messages";`);
  }
}
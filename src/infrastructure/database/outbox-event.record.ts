import { EntitySchema } from "@mikro-orm/core";

export class OutboxEventRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  createdAt!: Date;
  publishedAt!: Date | null;
  attempts!: number;
  nextAttemptAt!: Date;
  lastError!: string | null;
}

export const OutboxEventRecordSchema =
  new EntitySchema<OutboxEventRecord>({
    class: OutboxEventRecord,
    tableName: "outbox_events",
    properties: {
      id: {
        type: "uuid",
        primary: true,
      },
      aggregateId: {
        type: "uuid",
        fieldName: "aggregate_id",
      },
      eventType: {
        type: "string",
        length: 100,
        fieldName: "event_type",
      },
      payload: {
        type: "json",
        columnType: "jsonb",
      },
      createdAt: {
        type: "Date",
        columnType: "timestamptz",
        fieldName: "created_at",
      },
      publishedAt: {
        type: "Date",
        columnType: "timestamptz",
        fieldName: "published_at",
        nullable: true,
      },
      attempts: {
        type: "integer",
        default: 0,
      },
      nextAttemptAt: {
        type: "Date",
        columnType: "timestamptz",
        fieldName: "next_attempt_at",
      },
      lastError: {
        type: "text",
        fieldName: "last_error",
        nullable: true,
      },
    },
    indexes: [
      {
        name: "outbox_publish_idx",
        properties: ["publishedAt", "nextAttemptAt", "createdAt"],
      },
    ],
    uniques: [
      {
        name: "outbox_aggregate_event_unique",
        properties: ["aggregateId", "eventType"],
      },
    ],
    checks: [
      {
        name: "outbox_attempts_nonnegative",
        expression: "attempts >= 0",
      },
    ],
  });
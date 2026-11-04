import { EntitySchema } from "@mikro-orm/core";

export class InboxMessageRecord {
  id!: string;
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  processedAt!: Date;
}

export const InboxMessageRecordSchema =
  new EntitySchema<InboxMessageRecord>({
    class: InboxMessageRecord,
    tableName: "inbox_messages",
    properties: {
      id: {
        type: "uuid",
        primary: true,
      },
      consumerName: {
        type: "string",
        length: 100,
        fieldName: "consumer_name",
      },
      messageId: {
        type: "string",
        length: 200,
        fieldName: "message_id",
      },
      payloadHash: {
        type: "string",
        length: 64,
        fieldName: "payload_hash",
      },
      processedAt: {
        type: "Date",
        columnType: "timestamptz",
        fieldName: "processed_at",
      },
    },
    uniques: [
      {
        name: "inbox_consumer_message_unique",
        properties: ["consumerName", "messageId"],
      },
    ],
  });
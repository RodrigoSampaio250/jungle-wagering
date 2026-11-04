import {
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { canonicalPayloadHash } from "../../application/canonical-payload-hash";
import config from "../database/mikro-orm.config";
import { InboxExecutor } from "../database/inbox-executor";
import { SqsInboxConsumer } from "./sqs-inbox-consumer";

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

let orm: MikroORM | undefined;

try {
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({
      QueueName: "wagering-events",
    }),
  );

  if (!QueueUrl) {
    throw new Error("A fila wagering-events não foi encontrada.");
  }

  orm = await MikroORM.init(config);

  const consumer = new SqsInboxConsumer(
    client,
    QueueUrl,
    "transaction-events-v1",
    new InboxExecutor(orm),
    (body) => {
      const payload = JSON.parse(body);

      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        typeof payload.eventId !== "string" ||
        !payload.eventId.trim() ||
        typeof payload.eventType !== "string" ||
        !payload.eventType.trim()
      ) {
        throw new Error("Evento inválido.");
      }

      return {
        messageId: payload.eventId,
        payloadHash: canonicalPayloadHash(payload),
        payload,
      };
    },
    async () => {
      // Por enquanto, o efeito persistido é o recibo na inbox.
      // Uma projeção futura deve usar o EntityManager recebido aqui.
    },
  );

  const result = await consumer.consumeOne();

  console.log(
    JSON.stringify({
      event: "inbox.consume_once",
      result,
    }),
  );
} finally {
  try {
    await orm?.close(true);
  } finally {
    client.destroy();
  }
}
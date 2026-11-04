import {
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/mikro-orm.config";
import { OutboxPublisher } from "../database/outbox-publisher";
import { SqsEventPublisher } from "./sqs-event-publisher";

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
  const queue = await client.send(
    new GetQueueUrlCommand({
      QueueName: "wagering-events",
    }),
  );

  if (!queue.QueueUrl) {
    throw new Error("Fila wagering-events não encontrada.");
  }

  orm = await MikroORM.init(config);

  const publisher = new OutboxPublisher(
    orm,
    new SqsEventPublisher(client, queue.QueueUrl),
  );

  const result = await publisher.publishOne();

  console.log(JSON.stringify({
    event: "outbox.publish_once",
    result,
  }));
} catch (error: unknown) {
  console.error("Falha ao publicar outbox:", error);
  process.exitCode = 1;
} finally {
  try {
    if (orm) {
      await orm.close(true);
    }
  } finally {
    client.destroy();
  }
}
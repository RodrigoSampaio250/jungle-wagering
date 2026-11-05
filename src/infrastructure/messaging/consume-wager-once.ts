import {
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/mikro-orm.config";
import { createWagerConsumer } from "./wager-consumer";

const queueName = "wager-transactions.fifo";

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

let orm: MikroORM | undefined;

try {
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({
      QueueName: queueName,
    }),
  );

  if (!QueueUrl) {
    throw new Error(`A fila ${queueName} não foi encontrada.`);
  }

  orm = await MikroORM.init(config);

  const consumer = createWagerConsumer(client, QueueUrl, orm);
  const result = await consumer.consumeOne();

  console.log(
    JSON.stringify({
      event: "wager.consume_once",
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
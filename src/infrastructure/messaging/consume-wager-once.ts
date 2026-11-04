import {
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/mikro-orm.config";
import { createWagerConsumer } from "./wager-consumer";

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
      QueueName: "wagering-transactions",
    }),
  );

  if (!QueueUrl) {
    throw new Error("A fila wagering-transactions não foi encontrada.");
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
import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { createWagerConsumer } from "../../src/infrastructure/messaging/wager-consumer";

const queueUrl = process.env.CRASH_TEST_QUEUE_URL;
const mode = process.env.CRASH_TEST_MODE;

if (!queueUrl || !["crash", "resume"].includes(mode ?? "")) {
  throw new Error("Configuração do processo de teste inválida.");
}

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
  maxAttempts: 1,
  requestHandler: {
    connectionTimeout: 3_000,
    requestTimeout: 10_000,
  },
});

// Intercepta somente o envio do ack neste processo de teste.
// Quando chegamos aqui, o consumidor já confirmou o inbox.
client.middlewareStack.add(
  (next, context) => async (args) => {
    if (
      mode === "crash" &&
      context.commandName === "DeleteMessageCommand"
    ) {
      const input = args.input as {
        ReceiptHandle?: string;
      };

      if (!input.ReceiptHandle) {
        throw new Error("Ack sem receipt handle.");
      }

      console.log(
        `CRASH_READY ${JSON.stringify({
          receiptHandle: input.ReceiptHandle,
        })}`,
      );

      // O processo pai vai encerrar este processo à força.
      // Nenhum DeleteMessage chega ao SQS.
      while (true) {
        await Bun.sleep(1_000);
      }
    }

    return next(args);
  },
  {
    step: "initialize",
    name: "crashBeforeAck",
  },
);

const orm = await MikroORM.init(config);

try {
  const consumer = createWagerConsumer(client, queueUrl, orm);
  const result = await consumer.consumeOne(2);

  console.log(`CONSUME_RESULT ${result}`);
} finally {
  try {
    await orm.close(true);
  } finally {
    client.destroy();
  }
}
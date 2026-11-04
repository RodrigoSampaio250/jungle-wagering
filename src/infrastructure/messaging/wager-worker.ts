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
  maxAttempts: 3,
  requestHandler: {
    connectionTimeout: 3_000,
    requestTimeout: 20_000,
  },
});

let orm: MikroORM | undefined;
let stopping = false;
let wakeUp: (() => void) | undefined;

function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  wakeUp?.();

  console.log(
    JSON.stringify({
      event: "wager.worker.stopping",
    }),
  );
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wakeUp = undefined;
      resolve();
    };

    const timer = setTimeout(finish, ms);
    wakeUp = finish;

    if (stopping) {
      finish();
    }
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({
      QueueName: "wagering-transactions",
    }),
  );

  if (!QueueUrl) {
    throw new Error(
      "A fila wagering-transactions não foi encontrada.",
    );
  }

  orm = await MikroORM.init(config);

  const consumer = createWagerConsumer(client, QueueUrl, orm);

  console.log(
    JSON.stringify({
      event: "wager.worker.started",
    }),
  );

  while (!stopping) {
    try {
      const result = await consumer.consumeOne(10);

      if (result !== "empty") {
        console.log(
          JSON.stringify({
            event: "wager.worker.result",
            result,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "wager.worker.error",
          message:
            error instanceof Error
              ? error.message
              : String(error),
        }),
      );

      await pause(2_000);
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "wager.worker.start_failed",
      message:
        error instanceof Error
          ? error.message
          : String(error),
    }),
  );

  process.exitCode = 1;
} finally {
  try {
    await orm?.close(true);
  } finally {
    client.destroy();

    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);

    console.log(
      JSON.stringify({
        event: "wager.worker.stopped",
      }),
    );
  }
}
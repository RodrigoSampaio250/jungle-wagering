import {
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/mikro-orm.config";
import { logger } from "../observability/execution-context";
import {
  startMetricsServer,
  type MetricsServer,
} from "../observability/metrics-server";
import { createWagerConsumer } from "./wager-consumer";
import {
  registerDlqMetrics,
} from "../observability/sqs-queue-metrics";

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
  maxAttempts: 3,
  requestHandler: {
    connectionTimeout: 3_000,
    requestTimeout: 20_000,
  },
});

let orm: MikroORM | undefined;
let metricsServer: MetricsServer | undefined;
let stopping = false;
let wakeUp: (() => void) | undefined;

function requestStop(): void {
  if (stopping) {
    return;
  }

  stopping = true;
  wakeUp?.();

  logger.info("wager.worker.stopping");
}

function pause(milliseconds: number): Promise<void> {
  if (stopping) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      wakeUp = undefined;
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    wakeUp = finish;
  });
}

process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

try {
 await registerDlqMetrics(client);
 metricsServer = await startMetricsServer();

  const queue = await client.send(
    new GetQueueUrlCommand({
      QueueName: "wager-transactions.fifo",
    }),
  );

  if (!queue.QueueUrl) {
    throw new Error(
      "Fila wager-transactions.fifo não encontrada.",
    );
  }

  orm = await MikroORM.init(config);

  const consumer = createWagerConsumer(
    client,
    queue.QueueUrl,
    orm,
  );

  logger.info("wager.worker.started");

  while (!stopping) {
    try {
      const result = await consumer.consumeOne(10);

      if (result !== "empty") {
        logger.info("wager.worker.result", { result });
      }
    } catch (error: unknown) {
      logger.error("wager.worker.error", {
        errorType:
          error instanceof Error
            ? error.name
            : "UnknownError",
      });

      await pause(2_000);
    }
  }
} catch (error: unknown) {
  logger.error("wager.worker.start_failed", {
    errorType:
      error instanceof Error
        ? error.name
        : "UnknownError",
  });

  process.exitCode = 1;
} finally {
  try {
    await metricsServer?.stop();
  } finally {
    try {
      await orm?.close(true);
    } finally {
      client.destroy();
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);

      logger.info("wager.worker.stopped");
    }
  }
}
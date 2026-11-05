import {
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/mikro-orm.config";
import { OutboxPublisher } from "../database/outbox-publisher";
import { logger } from "../observability/execution-context";
import {
  startMetricsServer,
  type MetricsServer,
} from "../observability/metrics-server";
import { SqsEventPublisher } from "./sqs-event-publisher";

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
    requestTimeout: 10_000,
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

  logger.info("outbox.worker.stopping");
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
  metricsServer = await startMetricsServer();

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

  logger.info("outbox.worker.started");

  while (!stopping) {
    try {
      const result = await publisher.publishOne();

      if (result === "empty") {
        await pause(1_000);
      } else {
        logger.info("outbox.worker.result", { result });

        if (result === "retry") {
          await pause(500);
        }
      }
    } catch (error: unknown) {
      logger.error("outbox.worker.error", {
        errorType:
          error instanceof Error
            ? error.name
            : "UnknownError",
      });

      await pause(2_000);
    }
  }
} catch (error: unknown) {
  logger.error("outbox.worker.start_failed", {
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

      logger.info("outbox.worker.stopped");
    }
  }
}
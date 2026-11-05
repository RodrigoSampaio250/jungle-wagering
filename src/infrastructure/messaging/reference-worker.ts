import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/mikro-orm.config";
import { ReferenceWorker } from "../database/reference-worker";
import { logger } from "../observability/execution-context";
import {
  startMetricsServer,
  type MetricsServer,
} from "../observability/metrics-server";

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

  logger.info("reference.worker.stopping");
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
  const ttlMs = Number(
    process.env.REFERENCE_TTL_MS ?? "3600000",
  );

  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(
      "REFERENCE_TTL_MS deve ser um inteiro positivo.",
    );
  }

  metricsServer = await startMetricsServer();

  orm = await MikroORM.init(config);

  const worker = new ReferenceWorker(orm, ttlMs);

  logger.info("reference.worker.started", { ttlMs });

  while (!stopping) {
    try {
      const result = await worker.processOne();

      if (result === "empty") {
        await pause(1_000);
        continue;
      }

      logger.info("reference.worker.result", { result });
    } catch (error: unknown) {
      logger.error("reference.worker.error", {
        errorType:
          error instanceof Error
            ? error.name
            : "UnknownError",
      });

      await pause(2_000);
    }
  }
} catch (error: unknown) {
  logger.error("reference.worker.start_failed", {
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
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);

      logger.info("reference.worker.stopped");
    }
  }
}
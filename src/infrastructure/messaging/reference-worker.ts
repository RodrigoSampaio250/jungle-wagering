import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/mikro-orm.config";
import { ReferenceWorker } from "../database/reference-worker";

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
      event: "reference.worker.stopping",
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
  // Padrão operacional inicial: 1 hora.
  // Pode ser alterado pela variável de ambiente.
  const ttlMs = Number(
    process.env.REFERENCE_TTL_MS ?? "3600000",
  );

  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(
      "REFERENCE_TTL_MS deve ser um inteiro positivo.",
    );
  }

  orm = await MikroORM.init(config);

  const worker = new ReferenceWorker(orm, ttlMs);

  console.log(
    JSON.stringify({
      event: "reference.worker.started",
      ttlMs,
    }),
  );

  while (!stopping) {
    try {
      const result = await worker.processOne();

      if (result === "empty") {
        await pause(1_000);
        continue;
      }

      console.log(
        JSON.stringify({
          event: "reference.worker.result",
          result,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "reference.worker.error",
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
      event: "reference.worker.start_failed",
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
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);

    console.log(
      JSON.stringify({
        event: "reference.worker.stopped",
      }),
    );
  }
}
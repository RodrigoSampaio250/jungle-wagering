import { createServer } from "node:http";
import { logger } from "./execution-context";
import { metricsRegistry } from "./metrics";

export interface MetricsServer {
  stop(): Promise<void>;
}

export async function startMetricsServer(): Promise<MetricsServer> {
  const port = Number(process.env.METRICS_PORT ?? "9100");

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      "METRICS_PORT deve ser um inteiro entre 1 e 65535.",
    );
  }

  const server = createServer((request, response) => {
    if (
      request.method !== "GET" ||
      request.url !== "/metrics"
    ) {
      response.writeHead(404);
      response.end();
      return;
    }

    void metricsRegistry.metrics()
      .then((body) => {
        if (response.destroyed) {
          return;
        }

        response.writeHead(200, {
          "Content-Type": metricsRegistry.contentType,
        });

        response.end(body);
      })
      .catch((error: unknown) => {
        logger.error("metrics.collection.failed", {
          errorType:
            error instanceof Error
              ? error.name
              : "UnknownError",
        });

        if (!response.destroyed) {
          response.writeHead(500);
          response.end();
        }
      });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once("error", onError);

    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      resolve();
    });
  });

  server.on("error", (error: Error) => {
    logger.error("metrics.server.failed", {
      errorType: error.name,
    });
  });

  logger.info("metrics.server.started", { port });

  return {
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });

        // Encerra conexões ociosas durante o shutdown.
        server.closeIdleConnections();
      });

      logger.info("metrics.server.stopped");
    },
  };
}
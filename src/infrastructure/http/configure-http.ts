import {
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common";
import {
  correlationIdFrom,
  logger,
  runWithContext,
} from "../observability/execution-context";

interface HttpRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  route?: {
    path?: unknown;
  };
}

interface HttpResponse {
  statusCode: number;
  writableFinished: boolean;

  setHeader(name: string, value: string): unknown;

  once(
    event: "finish" | "close",
    listener: () => void,
  ): unknown;
}

export function configureHttp(app: INestApplication): void {
  app.use(
    (
      request: HttpRequest,
      response: HttpResponse,
      next: () => void,
    ): void => {
      const correlationId = correlationIdFrom(
        request.headers["x-correlation-id"],
      );

      response.setHeader("X-Correlation-Id", correlationId);

      runWithContext({ correlationId }, () => {
        const startedAt = performance.now();
        let logged = false;

        const logCompletion = (aborted: boolean): void => {
          if (logged) {
            return;
          }

          logged = true;

          const fields = {
            method: request.method,
            // Usa o padrão da rota, sem query string ou IDs da URL.
            route:
              typeof request.route?.path === "string"
                ? request.route.path
                : "unmatched",
            statusCode: response.statusCode,
            durationMs:
              Math.round(
                (performance.now() - startedAt) * 100,
              ) / 100,
            aborted,
          };

          // Garante o contexto mesmo em callbacks do transporte HTTP.
          runWithContext({ correlationId }, () => {
            if (aborted || response.statusCode >= 500) {
              logger.error("http.request.completed", fields);
            } else if (response.statusCode >= 400) {
              logger.warn("http.request.completed", fields);
            } else {
              logger.info("http.request.completed", fields);
            }
          });
        };

        response.once("finish", () => {
          logCompletion(false);
        });

        response.once("close", () => {
          logCompletion(!response.writableFinished);
        });

        next();
      });
    },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );
}
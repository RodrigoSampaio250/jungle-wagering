import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { Gauge } from "prom-client";
import { logger } from "./execution-context";
import { metricsRegistry } from "./metrics";

export async function registerDlqMetrics(
  client: SQSClient,
): Promise<void> {
  const queue = await client.send(
    new GetQueueUrlCommand({
      QueueName: "wager-transactions-dlq.fifo",
    }),
  );

  const queueUrl = queue.QueueUrl;

  if (!queueUrl) {
    throw new Error(
      "Fila wager-transactions-dlq.fifo não encontrada.",
    );
  }

  let pendingCollection: Promise<void> | undefined;

  const collectionSuccess = new Gauge({
    name: "wagering_dlq_collection_success",
    help: "Uma coleta bem-sucedida da DLQ vale 1; falha vale 0.",
    registers: [metricsRegistry],

    async collect() {
      await refresh();
    },
  });

  const messages = new Gauge({
    name: "wagering_dlq_messages",
    help: "Quantidade aproximada de mensagens na DLQ por estado.",
    labelNames: ["state"] as const,
    registers: [metricsRegistry],

    async collect() {
      await refresh();
    },
  });

  function refresh(): Promise<void> {
    // As duas métricas aguardam a mesma consulta em andamento.
    if (pendingCollection === undefined) {
      pendingCollection = collectSnapshot().finally(() => {
        pendingCollection = undefined;
      });
    }

    return pendingCollection;
  }

  async function collectSnapshot(): Promise<void> {
    try {
      const response = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "ApproximateNumberOfMessagesDelayed",
          ],
        }),
      );

      const attributes = response.Attributes;

      const values = {
        visible: Number(
          attributes?.ApproximateNumberOfMessages,
        ),
        in_flight: Number(
          attributes?.ApproximateNumberOfMessagesNotVisible,
        ),
        delayed: Number(
          attributes?.ApproximateNumberOfMessagesDelayed,
        ),
      };

      for (const value of Object.values(values)) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(
            "SQS retornou uma contagem inválida para a DLQ.",
          );
        }
      }

      messages.set({ state: "visible" }, values.visible);
      messages.set({ state: "in_flight" }, values.in_flight);
      messages.set({ state: "delayed" }, values.delayed);

      collectionSuccess.set(1);
    } catch (error: unknown) {
      messages.reset();
      collectionSuccess.set(0);

      logger.error("dlq.metrics.collection_failed", {
        errorType:
          error instanceof Error
            ? error.name
            : "UnknownError",
      });
    }
  }
}
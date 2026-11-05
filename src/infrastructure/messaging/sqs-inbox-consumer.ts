import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { EntityManager } from "@mikro-orm/postgresql";
import {
  InboxExecutor,
  type InboxExecutionResult,
} from "../database/inbox-executor";
import {
  correlationIdFrom,
  logger,
  runWithContext,
} from "../observability/execution-context";
import {
  inboxResults,
  messageFailures,
  messageRedeliveries,
} from "../observability/metrics";

export interface InboxEnvelope<T> {
  readonly messageId: string;
  readonly payloadHash: string;
  readonly payload: T;
}

export type ConsumeResult = InboxExecutionResult | "empty";

type AfterCommit = () => void;
type FailurePhase = "decode" | "process" | "ack";

function businessIdentifiers(
  payload: unknown,
): {
  walletId?: string;
  providerId?: string;
} {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return {};
  }

  const data = payload as Record<string, unknown>;

  return {
    ...(typeof data.walletId === "string"
      ? { walletId: data.walletId }
      : {}),
    ...(typeof data.providerId === "string"
      ? { providerId: data.providerId }
      : {}),
  };
}

export class SqsInboxConsumer<T> {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly consumerName: string,
    private readonly inbox: InboxExecutor,
    private readonly decode: (body: string) => InboxEnvelope<T>,
    private readonly handler: (
      em: EntityManager,
      payload: T,
    ) => Promise<void | AfterCommit>,
  ) {}

  async consumeOne(
    waitTimeSeconds = 10,
  ): Promise<ConsumeResult> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: 60,
        MessageSystemAttributeNames: [
          "ApproximateReceiveCount",
        ],
      }),
    );

    const message = response.Messages?.[0];

    if (message === undefined) {
      return "empty";
    }

    const parsedCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? "1",
    );

    const receiveCount =
      Number.isSafeInteger(parsedCount) && parsedCount > 0
        ? parsedCount
        : 1;

    if (receiveCount > 1) {
      messageRedeliveries.inc();
    }

    return runWithContext(
      {
        correlationId: correlationIdFrom(message.MessageId),
        ...(message.MessageId !== undefined
          ? { messageId: message.MessageId }
          : {}),
      },
      async (): Promise<ConsumeResult> => {
        const startedAt = performance.now();
        let envelope: InboxEnvelope<T>;

        try {
          if (
            message.Body === undefined ||
            !message.ReceiptHandle
          ) {
            throw new Error(
              "SQS retornou mensagem sem corpo ou receipt handle.",
            );
          }

          envelope = this.decode(message.Body);
        } catch (error: unknown) {
          this.logFailure(
            error,
            "decode",
            receiveCount,
            startedAt,
          );

          throw error;
        }

        const receiptHandle = message.ReceiptHandle;

        return runWithContext(
          {
            correlationId: correlationIdFrom(
              envelope.messageId,
            ),
            messageId: envelope.messageId,
            ...businessIdentifiers(envelope.payload),
          },
          async (): Promise<ConsumeResult> => {
            let phase: FailurePhase = "process";
            const observation: {
              afterCommit?: AfterCommit;
            } = {};

            try {
              const result = await this.inbox.execute(
                this.consumerName,
                envelope.messageId,
                envelope.payloadHash,
                async (em) => {
                  const callback = await this.handler(
                    em,
                    envelope.payload,
                  );

                  if (typeof callback === "function") {
                    observation.afterCommit = callback;
                  }
                },
              );

              inboxResults.inc({ result });

              // Somente observabilidade: nunca colocar
              // efeitos financeiros nesta função.
              if (observation.afterCommit !== undefined) {
                try {
                  observation.afterCommit();
                } catch (error: unknown) {
                  logger.error("inbox.observation.failed", {
                    errorType:
                      error instanceof Error
                        ? error.name
                        : "UnknownError",
                  });
                }
              }

              logger.info("inbox.execution.committed", {
                consumer: this.consumerName,
                result,
                receiveCount,
              });

              phase = "ack";

              await this.client.send(
                new DeleteMessageCommand({
                  QueueUrl: this.queueUrl,
                  ReceiptHandle: receiptHandle,
                }),
              );

              logger.info("sqs.message.acknowledged", {
                consumer: this.consumerName,
                result,
                receiveCount,
                durationMs:
                  Math.round(
                    (performance.now() - startedAt) * 100,
                  ) / 100,
              });

              return result;
            } catch (error: unknown) {
              this.logFailure(
                error,
                phase,
                receiveCount,
                startedAt,
              );

              throw error;
            }
          },
        );
      },
    );
  }

  private logFailure(
    error: unknown,
    phase: FailurePhase,
    receiveCount: number,
    startedAt: number,
  ): void {
    messageFailures.inc({ phase });

    logger.error("sqs.message.failed", {
      consumer: this.consumerName,
      phase,
      receiveCount,
      errorType:
        error instanceof Error
          ? error.name
          : "UnknownError",
      durationMs:
        Math.round(
          (performance.now() - startedAt) * 100,
        ) / 100,
    });
  }
}
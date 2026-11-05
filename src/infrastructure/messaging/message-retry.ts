import {
  ChangeMessageVisibilityCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../../application/ports/wager-processor";
import { InvalidMoneyError } from "../../domain/money";
import {
  InvalidWagerTransactionError,
} from "../../domain/wager-transaction.types";
import {
  InboxPayloadConflictError,
} from "../database/inbox-executor";
import { logger } from "../observability/execution-context";
import { lockConflicts } from "../observability/metrics";

export type MessageFailurePhase = "decode" | "process" | "ack";

function isLockConflict(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }

    const details = current as Record<string, unknown>;

    if (
      details.code === "40P01" ||
      details.code === "55P03"
    ) {
      return true;
    }

    current = details.cause;
  }

  return false;
}

export async function scheduleMessageRetry(
  client: SQSClient,
  queueUrl: string,
  receiptHandle: string | undefined,
  receiveCount: number,
  phase: MessageFailurePhase,
  error: unknown,
): Promise<void> {
  if (isLockConflict(error)) {
    lockConflicts.inc();
  }

  const permanent =
    phase === "decode" ||
    (
      phase === "process" &&
      (
        error instanceof InboxPayloadConflictError ||
        error instanceof IdempotencyConflictError ||
        error instanceof ExternalTransactionConflictError ||
        error instanceof InvalidMoneyError ||
        error instanceof InvalidWagerTransactionError
      )
    );

  // Falhas permanentes seguem para o redrive do SQS.
  // Transitórias recebem backoff: 2, 4, 8... até 300 segundos.
  const visibilitySeconds = permanent
    ? 0
    : Math.min(
        300,
        2 ** Math.min(Math.max(receiveCount, 1), 9),
      );

  logger.warn("sqs.message.retry_scheduled", {
    phase,
    classification: permanent ? "permanent" : "transient",
    receiveCount,
    visibilitySeconds,
  });

  if (receiptHandle === undefined) {
    return;
  }

  try {
    await client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilitySeconds,
      }),
    );
  } catch (visibilityError: unknown) {
    // Preserva a falha original. A visibilidade anterior
    // continua determinando quando poderá haver reentrega.
    logger.error("sqs.message.visibility_change_failed", {
      errorType:
        visibilityError instanceof Error
          ? visibilityError.name
          : "UnknownError",
    });
  }
}
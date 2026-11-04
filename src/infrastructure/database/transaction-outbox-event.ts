import { randomUUID } from "node:crypto";
import {
  WagerTransactionStatus as Status,
} from "../../domain/wager-transaction.types";
import type { OutboxEventRecord } from "./outbox-event.record";
import type { WagerTransactionRecord } from "./wager-transaction.record";

export function transactionOutboxEvent(
  transaction: WagerTransactionRecord,
): OutboxEventRecord | undefined {
  if (
    transaction.status !== Status.Processed &&
    transaction.status !== Status.Rejected &&
    transaction.status !== Status.Failed
  ) {
    return undefined;
  }

  const id = randomUUID();
  const at = new Date();
  const eventType =
    `transaction.${transaction.status.toLowerCase()}`;

  return {
    id,
    aggregateId: transaction.id,
    eventType,
    payload: {
      eventId: id,
      eventType,
      schemaVersion: 1,
      occurredAt: at.toISOString(),
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      balance:
        transaction.resultBalance === null
          ? null
          : {
              amount: transaction.resultBalance,
              currency: transaction.currency,
            },
      failureCode: transaction.failureCode,
      referenceTransactionId: transaction.referenceTransactionId,
    },
    createdAt: at,
    publishedAt: null,
    attempts: 0,
    nextAttemptAt: at,
    lastError: null,
  };
}
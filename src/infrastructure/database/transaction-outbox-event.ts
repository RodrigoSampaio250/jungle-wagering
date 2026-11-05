import { randomUUID } from "node:crypto";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type WagerTransactionEventData,
} from "../../domain/events/wagering-events";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import {
  WagerTransactionStatus as Status,
} from "../../domain/wager-transaction.types";
import type { OutboxEventRecord } from "./outbox-event.record";
import type { WagerTransactionRecord } from "./wager-transaction.record";

function toOutbox<T extends object>(
  event: IntegrationEvent<T>,
): OutboxEventRecord {
  const now = new Date();

  return {
    id: event.eventId,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: structuredClone({ ...event.toJSON() }),
    createdAt: now,
    publishedAt: null,
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
  };
}

export function transactionOutboxEvent(
  transaction: WagerTransactionRecord,
): OutboxEventRecord | undefined {
  const data: WagerTransactionEventData = {
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
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId,
    referenceTransactionId:
      transaction.referenceTransactionId,
  };

  const props = {
    eventId: randomUUID(),
    aggregateId: transaction.id,
    correlationId: transaction.id,
    occurredAt: transaction.processedAt ?? new Date(),
    data,
  };

  switch (transaction.status) {
    case Status.Processed:
      return toOutbox(
        WagerTransactionProcessed.create(props),
      );

    case Status.Rejected:
      return toOutbox(
        WagerTransactionRejected.create(props),
      );

    case Status.Failed:
      return toOutbox(
        WagerTransactionFailed.create(props),
      );

    case Status.PendingReference:
      // As retentativas atualizam o agendamento,
      // mas não repetem o evento de entrada em pendência.
      if (transaction.referenceAttempts > 0) {
        return undefined;
      }

      return toOutbox(
        WagerTransactionPendingReference.create(props),
      );

    case Status.Pending:
      return undefined;
  }
}

export function balanceChangedOutboxEvent(
  entry: WalletLedgerEntry,
  walletVersion: number,
): OutboxEventRecord {
  return toOutbox(
    WalletBalanceChanged.create({
      eventId: randomUUID(),

      // Os eventos desta operação são agrupados
      // pela identidade da transação financeira.
      aggregateId: entry.transactionId,
      correlationId: entry.transactionId,
      occurredAt: entry.createdAt,
      data: {
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion,
      },
    }),
  );
}
import { randomUUID } from "node:crypto";
import {
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import type {
  EntityManager,
  MikroORM,
} from "@mikro-orm/postgresql";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  type WagerProcessingResult,
  type WagerProcessor,
} from "../../application/ports/wager-processor";
import { InsufficientBalanceError } from "../../domain/wallet";
import { LedgerDirection } from "../../domain/wallet-ledger-entry";
import type { WagerTransaction } from "../../domain/wager-transaction";
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../domain/wager-transaction.types";
import { WalletRecord } from "./wallet.record";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";
import { WagerTransactionRecord } from "./wager-transaction.record";
import {
  ledgerEntryToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
} from "./wager-mappers";
import { OutboxEventRecord } from "./outbox-event.record";
import { transactionOutboxEvent } from "./transaction-outbox-event";

export class MikroOrmWagerProcessor implements WagerProcessor {
  constructor(
    private readonly orm: MikroORM,
    private readonly transactionManager?: EntityManager,
  ) {}

  async process(
    transaction: WagerTransaction,
  ): Promise<WagerProcessingResult> {
    try {
      return await this.processNew(transaction);
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) {
        throw error;
      }

      // A tentativa de inserção já foi revertida.
      // No consumidor, permanecemos na transação da inbox.
      const em = this.transactionManager ?? this.orm.em.fork();

      const existing = await em.findOne(WagerTransactionRecord, {
        idempotencyKey: transaction.idempotencyKey,
      });

      if (existing) {
        if (existing.payloadHash !== transaction.payloadHash) {
          throw new IdempotencyConflictError();
        }

        return this.resultFromRecord(existing, true);
      }

      const external = await em.findOne(WagerTransactionRecord, {
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
      });

      if (external) {
        throw new ExternalTransactionConflictError();
      }

      throw error;
    }
  }

  async retryPendingReference(
    record: WagerTransactionRecord,
  ): Promise<WagerProcessingResult> {
    if (
      !this.transactionManager ||
      !this.transactionManager.isInTransaction()
    ) {
      throw new Error(
        "A retomada exige uma transação ativa e o registro bloqueado.",
      );
    }

    if (record.status !== Status.PendingReference) {
      throw new Error(
        "Somente transações PENDING_REFERENCE podem ser retomadas.",
      );
    }

    return this.processNew(
      transactionFromRecord(record),
      record,
    );
  }

  private async processNew(
    transaction: WagerTransaction,
    existingRecord?: WagerTransactionRecord,
  ): Promise<WagerProcessingResult> {
    const manager = this.transactionManager ?? this.orm.em.fork();

    return manager.transactional(async (em) => {
      // Na primeira execução, reserva a identidade.
      // Na retomada, o worker já bloqueou o registro existente.
      if (!existingRecord) {
        await em.insert(
          WagerTransactionRecord,
          transactionToRecord(transaction),
        );
      }

      let resultBalance: string | null = null;

      const walletRecord = await em.findOne(
        WalletRecord,
        { id: transaction.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletRecord) {
        transaction.reject(FailureCode.WalletNotFound);
      } else if (walletRecord.playerId !== transaction.playerId) {
        transaction.reject(FailureCode.WalletPlayerMismatch);
      } else if (walletRecord.currency !== transaction.money.currency) {
        transaction.reject(FailureCode.CurrencyMismatch);
      } else if (
        transaction.kind === Kind.Opening ||
        transaction.providerId === "internal"
      ) {
        transaction.reject(FailureCode.InvalidProvider);
      } else {
        const wallet = walletFromRecord(walletRecord);
        resultBalance = wallet.balance.toString();

        let reference: WagerTransactionRecord | null = null;

        if (transaction.referenceExternalTransactionId !== undefined) {
          reference = await em.findOne(WagerTransactionRecord, {
            providerId: transaction.providerId,
            externalTransactionId:
              transaction.referenceExternalTransactionId,
          });

          if (
            !reference ||
            reference.status === Status.Pending ||
            reference.status === Status.PendingReference
          ) {
            transaction.markPendingReference();
          } else {
            const failure = this.referenceFailure(
              transaction,
              reference,
            );

            if (failure) {
              transaction.reject(failure);
            } else if (
              transaction.kind === Kind.Refund ||
              transaction.kind === Kind.Rollback
            ) {
              const previousReversal = await em.findOne(
                WagerTransactionRecord,
                {
                  referenceTransactionId: reference.id,
                  kind: transaction.kind,
                  status: Status.Processed,
                },
              );

              if (previousReversal) {
                transaction.reject(
                  FailureCode.ReferenceAlreadyReversed,
                );
              }
            }
          }
        }

        if (
          transaction.status === Status.Pending ||
          (
            transaction.status === Status.PendingReference &&
            reference?.status === Status.Processed
          )
        ) {
          const at = new Date();

          if (transaction.kind === Kind.Loss) {
            transaction.markProcessed(reference?.id, at);
          } else {
            const direction =
              transaction.kind === Kind.Rollback
                ? reference?.kind === Kind.Bet
                  ? LedgerDirection.Credit
                  : LedgerDirection.Debit
                : transaction.ledgerDirectionFor();

            const movement = {
              entryId: randomUUID(),
              transactionId: transaction.id,
              money: transaction.money,
              at,
            };

            try {
              const entry =
                direction === LedgerDirection.Debit
                  ? wallet.debit(movement)
                  : wallet.credit(movement);

              await em.nativeUpdate(
                WalletRecord,
                { id: wallet.id },
                {
                  balance: wallet.balance.toString(),
                  version: wallet.version,
                  updatedAt: wallet.updatedAt,
                },
              );

              await em.insert(
                WalletLedgerEntryRecord,
                ledgerEntryToRecord(entry),
              );

              transaction.markProcessed(reference?.id, at);
              resultBalance = wallet.balance.toString();
            } catch (error) {
              if (!(error instanceof InsufficientBalanceError)) {
                throw error;
              }

              if (transaction.kind === Kind.Rollback) {
                transaction.reject(
                  FailureCode.ReversalInsufficientBalance,
                );
              } else {
                transaction.reject(
                  FailureCode.InsufficientBalance,
                );
              }
            }
          }
        }
      }

      const record = transactionToRecord(
        transaction,
        resultBalance,
      );

      record.referenceAttempts = existingRecord
        ? existingRecord.referenceAttempts + 1
        : 0;

      if (transaction.status === Status.PendingReference) {
        const delayMs = Math.min(
          60_000,
          1_000 * 2 ** Math.min(record.referenceAttempts, 6),
        );

        record.nextReferenceAttemptAt = new Date(
          Date.now() + delayMs,
        );
      }

      // Persiste o resultado e o agendamento na mesma transação.
      await em.nativeUpdate(
        WagerTransactionRecord,
        { id: transaction.id },
        {
          status: record.status,
          referenceTransactionId: record.referenceTransactionId,
          failureCode: record.failureCode,
          resultBalance: record.resultBalance,
          referenceAttempts: record.referenceAttempts,
          nextReferenceAttemptAt: record.nextReferenceAttemptAt,
          processedAt: record.processedAt,
        },
      );

      const event = transactionOutboxEvent(record);

      if (event) {
        await em.insert(OutboxEventRecord, event);
      }

      return this.resultFromRecord(record, false);
    });
  }

  private referenceFailure(
    transaction: WagerTransaction,
    reference: WagerTransactionRecord,
  ): FailureCode | undefined {
    if (
      reference.walletId !== transaction.walletId ||
      reference.playerId !== transaction.playerId ||
      reference.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }

    if (reference.status !== Status.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }

    if (
      transaction.kind === Kind.Refund &&
      reference.kind !== Kind.Bet
    ) {
      return FailureCode.InvalidReferenceKind;
    }

    if (
      transaction.kind === Kind.Rollback &&
      reference.kind !== Kind.Bet &&
      reference.kind !== Kind.Win &&
      reference.kind !== Kind.Refund
    ) {
      return FailureCode.InvalidReferenceKind;
    }

    if (
      (transaction.kind === Kind.Refund ||
        transaction.kind === Kind.Rollback) &&
      reference.amount !== transaction.money.toString()
    ) {
      return FailureCode.ReferenceAmountMismatch;
    }

    return undefined;
  }

  private async resultFromRecord(
    record: WagerTransactionRecord,
    idempotentReplay: boolean,
  ): Promise<WagerProcessingResult> {
    return {
      transactionId: record.id,
      status: record.status,
      balance:
        record.resultBalance === null
          ? null
          : {
              amount: record.resultBalance,
              currency: record.currency,
            },
      failureCode: record.failureCode,
      idempotentReplay,
    };
  }
}
import { LockMode } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  FailureCode,
  WagerTransactionStatus as Status,
} from "../../domain/wager-transaction.types";
import { MikroOrmWagerProcessor } from "./mikro-orm-wager-processor";
import { OutboxEventRecord } from "./outbox-event.record";
import { transactionOutboxEvent } from "./transaction-outbox-event";
import { WagerTransactionRecord } from "./wager-transaction.record";
import {
  transactionFromRecord,
  transactionToRecord,
} from "./wager-mappers";

export type ReferenceWorkResult =
  | "empty"
  | "retry"
  | "processed"
  | "rejected"
  | "failed"
  | "expired";

export class ReferenceWorker {
  constructor(
    private readonly orm: MikroORM,
    private readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(
        "O prazo de espera da referência deve ser positivo, em milissegundos.",
      );
    }
  }

  async processOne(): Promise<ReferenceWorkResult> {
    return this.orm.em.fork().transactional(async (em) => {
      const now = new Date();
      const expirationCutoff = new Date(
        now.getTime() - this.ttlMs,
      );

      const record = await em.findOne(
        WagerTransactionRecord,
        {
          status: Status.PendingReference,
          $or: [
            { nextReferenceAttemptAt: { $lte: now } },
            { nextReferenceAttemptAt: null },
            { createdAt: { $lte: expirationCutoff } },
          ],
        },
        {
          orderBy: {
            createdAt: "asc",
            id: "asc",
          },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );

      if (!record) {
        return "empty";
      }

      if (record.createdAt.getTime() <= expirationCutoff.getTime()) {
        const transaction = transactionFromRecord(record);

        transaction.reject(FailureCode.ReferenceExpired);

        const expired = transactionToRecord(
          transaction,
          record.resultBalance,
        );

        await em.nativeUpdate(
          WagerTransactionRecord,
          { id: record.id },
          {
            status: expired.status,
            failureCode: expired.failureCode,
            nextReferenceAttemptAt: null,
            processedAt: expired.processedAt,
          },
        );

        const event = transactionOutboxEvent(expired);

        if (!event) {
          throw new Error(
            "A expiração deve gerar um evento terminal.",
          );
        }

        await em.insert(OutboxEventRecord, event);

        return "expired";
      }

      const result = await new MikroOrmWagerProcessor(
        this.orm,
        em,
      ).retryPendingReference(record);

      switch (result.status) {
        case Status.PendingReference:
          return "retry";

        case Status.Processed:
          return "processed";

        case Status.Rejected:
          return "rejected";

        case Status.Failed:
          return "failed";

        default:
          throw new Error(
            `Status inesperado após retomada: ${result.status}.`,
          );
      }
    });
  }
}
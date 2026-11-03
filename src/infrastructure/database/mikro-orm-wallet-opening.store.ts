import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  WalletAlreadyExistsError,
  type WalletOpening,
  type WalletOpeningStore,
} from "../../application/ports/wallet-opening-store";
import { WalletRecord } from "./wallet.record";
import { WagerTransactionRecord } from "./wager-transaction.record";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";

export class MikroOrmWalletOpeningStore
  implements WalletOpeningStore {
  constructor(private readonly orm: MikroORM) {}

  async save(opening: WalletOpening): Promise<void> {
    const { wallet, transaction, entry } = opening;

    if (
      (transaction === undefined) !== (entry === undefined) ||
      wallet.balance.isPositive() !== (transaction !== undefined)
    ) {
      throw new Error("Abertura de wallet incompleta.");
    }

    try {
      await this.orm.em.fork().transactional(async (em) => {
        await em.insert(WalletRecord, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toString(),
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });

        if (transaction === undefined || entry === undefined) {
          return;
        }

        await em.insert(WagerTransactionRecord, {
          id: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey,
          payloadHash: transaction.payloadHash,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
          kind: transaction.kind,
          amount: transaction.money.toString(),
          currency: transaction.money.currency,
          status: transaction.status,
          referenceExternalTransactionId:
            transaction.referenceExternalTransactionId ?? null,
          referenceTransactionId:
            transaction.referenceTransactionId ?? null,
          failureCode: transaction.failureCode ?? null,
          resultBalance: wallet.balance.toString(),
          referenceAttempts: 0,
          nextReferenceAttemptAt: null,
          createdAt: transaction.createdAt,
          processedAt: transaction.processedAt ?? null,
        });

        await em.insert(WalletLedgerEntryRecord, {
          id: entry.id,
          walletId: entry.walletId,
          transactionId: entry.transactionId,
          direction: entry.direction,
          amount: entry.money.toString(),
          currency: entry.money.currency,
          balanceBefore: entry.balanceBefore.toString(),
          balanceAfter: entry.balanceAfter.toString(),
          createdAt: entry.createdAt,
        });
      });
    } catch (error: unknown) {
      if (
        error instanceof UniqueConstraintViolationException &&
        error.message.includes("wallets_player_currency_unique")
      ) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }
}
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
import { OutboxEventRecord } from "./outbox-event.record";
import {
  balanceChangedOutboxEvent,
  transactionOutboxEvent,
} from "./transaction-outbox-event";
import {
  ledgerEntryToRecord,
  transactionToRecord,
} from "./wager-mappers";

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

        const record = transactionToRecord(
          transaction,
          wallet.balance.toString(),
        );

        await em.insert(
          WagerTransactionRecord,
          record,
        );

        await em.insert(
          WalletLedgerEntryRecord,
          ledgerEntryToRecord(entry),
        );

        const event = transactionOutboxEvent(record);

        if (event) {
          await em.insert(OutboxEventRecord, event);
        }

        await em.insert(
          OutboxEventRecord,
          balanceChangedOutboxEvent(entry, wallet.version),
        );
      });
    } catch (error) {
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
import { createHash } from "node:crypto";
import { Money, type MoneyProps } from "../domain/money";
import { Wallet } from "../domain/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../domain/wallet-ledger-entry";
import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionKind } from "../domain/wager-transaction.types";
import type { WalletOpeningStore } from "./ports/wallet-opening-store";

export interface CreateWalletInput {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export class CreateWallet {
  constructor(private readonly store: WalletOpeningStore) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    const initialBalance = Money.from(input.initialBalance);
    const at = new Date();

    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: input.playerId,
      initialBalance,
      at,
    });

    if (initialBalance.isZero()) {
      await this.store.save({
        wallet,
        transaction: undefined,
        entry: undefined,
      });

      return this.toResult(wallet);
    }

    const transactionId = crypto.randomUUID();

    // Objeto interno de formato fixo, com chaves ordenadas.
    // O hash genérico dos contratos externos será implementado à parte.
    const openingPayload = {
      kind: WagerTransactionKind.Opening,
      money: {
        amount: initialBalance.toString(),
        currency: initialBalance.currency,
      },
      playerId: wallet.playerId,
      walletId: wallet.id,
    };

    const payloadHash = createHash("sha256")
      .update(JSON.stringify(openingPayload))
      .digest("hex");

    const transaction = WagerTransaction.create({
      id: transactionId,
      providerId: "internal",
      externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: `internal:opening:${wallet.id}`,
      payloadHash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `opening:${wallet.id}`,
      gameId: "wallet-opening",
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      createdAt: at,
    });

    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: at,
    });

    transaction.markProcessed(undefined, at);

    await this.store.save({
      wallet,
      transaction,
      entry,
    });

    return this.toResult(wallet);
  }

  private toResult(wallet: Wallet): CreateWalletResult {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
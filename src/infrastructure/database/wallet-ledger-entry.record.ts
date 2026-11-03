import { EntitySchema } from "@mikro-orm/core";
import { LedgerDirection } from "../../domain/wallet-ledger-entry";

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntryRecordSchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    class: WalletLedgerEntryRecord,
    tableName: "wallet_ledger_entries",
    properties: {
      id: { type: "uuid", primary: true },
      walletId: { type: "uuid" },
      transactionId: { type: "uuid" },
      direction: { type: "string", length: 6 },
      amount: {
        type: "string",
        columnType: "numeric(20,2)",
      },
      currency: { type: "string", length: 3 },
      balanceBefore: {
        type: "string",
        columnType: "numeric(20,2)",
      },
      balanceAfter: {
        type: "string",
        columnType: "numeric(20,2)",
      },
      createdAt: {
        type: "Date",
        columnType: "timestamptz",
      },
    },
    uniques: [
      {
        name: "ledger_wallet_transaction_unique",
        properties: ["walletId", "transactionId"],
      },
    ],
    indexes: [
      {
        name: "ledger_wallet_cursor_idx",
        properties: ["walletId", "createdAt", "id"],
      },
    ],
    checks: [
      {
        name: "ledger_amount_positive",
        expression: "amount > 0",
      },
      {
        name: "ledger_balances_nonnegative",
        expression: "balance_before >= 0 AND balance_after >= 0",
      },
      {
        name: "ledger_currency_valid",
        expression: "currency IN ('BRL', 'USD')",
      },
      {
        name: "ledger_arithmetic_valid",
        expression: `
          (direction = 'DEBIT'
            AND balance_after = balance_before - amount)
          OR
          (direction = 'CREDIT'
            AND balance_after = balance_before + amount)
        `,
      },
    ],
  });
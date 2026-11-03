import { EntitySchema } from "@mikro-orm/core";

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletRecordSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: {
      type: "uuid",
      primary: true,
    },
    playerId: {
      type: "uuid",
      fieldName: "player_id",
    },
    currency: {
      type: "string",
      length: 3,
    },
    balance: {
      type: "string",
      columnType: "numeric(20,2)",
    },
    version: {
      type: "integer",
    },
    createdAt: {
      type: "Date",
      columnType: "timestamptz",
      fieldName: "created_at",
    },
    updatedAt: {
      type: "Date",
      columnType: "timestamptz",
      fieldName: "updated_at",
    },
  },
  uniques: [
    {
      name: "wallets_player_currency_unique",
      properties: ["playerId", "currency"],
    },
  ],
  checks: [
    {
      name: "wallets_balance_nonnegative",
      expression: "balance >= 0",
    },
    {
      name: "wallets_version_positive",
      expression: "version >= 1",
    },
    {
      name: "wallets_currency_supported",
      expression: "currency IN ('BRL', 'USD')",
    },
  ],
});
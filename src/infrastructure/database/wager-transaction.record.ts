import { EntitySchema } from "@mikro-orm/core";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction.types";

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  status!: WagerTransactionStatus;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: FailureCode | null;
  resultBalance!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionRecordSchema =
  new EntitySchema<WagerTransactionRecord>({
    class: WagerTransactionRecord,
    tableName: "wager_transactions",
    properties: {
      id: { type: "uuid", primary: true },
      providerId: { type: "string", length: 100 },
      externalTransactionId: { type: "string", length: 200 },
      idempotencyKey: { type: "string", length: 300 },
      payloadHash: { type: "string", length: 64 },
      walletId: { type: "uuid" },
      playerId: { type: "uuid" },
      roundId: { type: "string", length: 200 },
      gameId: { type: "string", length: 200 },
      kind: { type: "string", length: 20 },
      amount: { type: "string", columnType: "numeric(20,2)" },
      currency: { type: "string", length: 3 },
      status: { type: "string", length: 30 },
      referenceExternalTransactionId: {
        type: "string",
        length: 200,
        nullable: true,
      },
      referenceTransactionId: {
        type: "uuid",
        nullable: true,
      },
      failureCode: {
        type: "string",
        length: 100,
        nullable: true,
      },
      resultBalance: {
        type: "string",
        columnType: "numeric(20,2)",
        nullable: true,
      },
      referenceAttempts: { type: "integer", default: 0 },
      nextReferenceAttemptAt: {
        type: "Date",
        columnType: "timestamptz",
        nullable: true,
      },
      createdAt: {
        type: "Date",
        columnType: "timestamptz",
      },
      processedAt: {
        type: "Date",
        columnType: "timestamptz",
        nullable: true,
      },
    },
    uniques: [
      {
        name: "wager_transactions_idempotency_unique",
        properties: ["idempotencyKey"],
      },
      {
        name: "wager_transactions_provider_external_unique",
        properties: ["providerId", "externalTransactionId"],
      },
    ],
    indexes: [
      {
        name: "wager_transactions_reference_retry_idx",
        properties: ["status", "nextReferenceAttemptAt"],
      },
      {
        name: "wager_transactions_wallet_idx",
        properties: ["walletId"],
      },
    ],
    checks: [
      {
        name: "wager_transactions_amount_valid",
        expression:
          "amount >= 0 AND (kind = 'LOSS' OR amount > 0)",
      },
      {
        name: "wager_transactions_kind_valid",
        expression:
          "kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
      },
      {
        name: "wager_transactions_status_valid",
        expression:
          "status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
      },
      {
        name: "wager_transactions_currency_valid",
        expression: "currency IN ('BRL', 'USD')",
      },
      {
        name: "wager_transactions_reference_required",
        expression:
          "kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL",
      },
      {
        name: "wager_transactions_attempts_valid",
        expression: "reference_attempts >= 0",
      },
      {
        name: "wager_transactions_result_balance_valid",
        expression: "result_balance IS NULL OR result_balance >= 0",
      },
    ],
  });
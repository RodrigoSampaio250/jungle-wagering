import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { isUUID } from "class-validator";
import { canonicalPayloadHash } from "../../application/canonical-payload-hash";
import {
  SubmitWager,
  type SubmitWagerInput,
} from "../../application/submit-wager";
import { WagerTransactionKind } from "../../domain/wager-transaction.types";
import { InboxExecutor } from "../database/inbox-executor";
import { MikroOrmWagerProcessor } from "../database/mikro-orm-wager-processor";
import { SqsInboxConsumer } from "./sqs-inbox-consumer";

function objectValue(
  value: unknown,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("A mensagem deve conter um objeto JSON.");
  }

  return value as Record<string, unknown>;
}

function text(
  object: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = object[field];

  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength
  ) {
    throw new Error(`Campo inválido: ${field}.`);
  }

  return value;
}

function decode(body: string) {
  const raw = objectValue(JSON.parse(body));
  const money = objectValue(raw.money);

  const messageId = text(raw, "messageId", 200);
  const playerId = text(raw, "playerId", 36);
  const walletId = text(raw, "walletId", 36);

  if (!isUUID(playerId) || !isUUID(walletId)) {
    throw new Error("playerId e walletId devem ser UUIDs.");
  }

  const kind = text(raw, "kind", 20);

  const allowedKinds = [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ];

  if (!allowedKinds.includes(kind as WagerTransactionKind)) {
    throw new Error("Tipo de transação inválido.");
  }

  const amount = text(money, "amount", 21);
  const currency = text(money, "currency", 3);

  if (
    !/^[0-9]{1,18}\.[0-9]{2}$/.test(amount) ||
    !["BRL", "USD"].includes(currency)
  ) {
    throw new Error("Valor monetário inválido.");
  }

  const payload: SubmitWagerInput = {
    providerId: text(raw, "providerId", 100),
    externalTransactionId: text(raw, "externalTransactionId", 200),
    idempotencyKey: text(raw, "idempotencyKey", 300),
    playerId,
    walletId,
    roundId: text(raw, "roundId", 200),
    gameId: text(raw, "gameId", 200),
    kind: kind as WagerTransactionKind,
    money: { amount, currency },
    ...(raw.referenceExternalTransactionId !== undefined
      ? {
          referenceExternalTransactionId: text(
            raw,
            "referenceExternalTransactionId",
            200,
          ),
        }
      : {}),
  };

  return {
    messageId,
    payloadHash: canonicalPayloadHash({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: payload.idempotencyKey,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: { amount, currency },
      ...(payload.referenceExternalTransactionId !== undefined
        ? {
            referenceExternalTransactionId:
              payload.referenceExternalTransactionId,
          }
        : {}),
    }),
    payload,
  };
}

export function createWagerConsumer(
  client: SQSClient,
  queueUrl: string,
  orm: MikroORM,
): SqsInboxConsumer<SubmitWagerInput> {
  return new SqsInboxConsumer(
    client,
    queueUrl,
    "wager-transactions-v1",
    new InboxExecutor(orm),
    decode,
    async (em, payload) => {
      const processor = new MikroOrmWagerProcessor(orm, em);
      const submitWager = new SubmitWager(processor);

      await submitWager.execute(payload);
    },
  );
}
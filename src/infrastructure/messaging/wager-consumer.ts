import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { isISO8601, isUUID } from "class-validator";
import { canonicalPayloadHash } from "../../application/canonical-payload-hash";
import {
  SubmitWager,
  type SubmitWagerInput,
} from "../../application/submit-wager";
import { WagerTransactionKind } from "../../domain/wager-transaction.types";
import { InboxExecutor } from "../database/inbox-executor";
import { MikroOrmWagerProcessor } from "../database/mikro-orm-wager-processor";
import {
  SqsInboxConsumer,
  type InboxEnvelope,
} from "./sqs-inbox-consumer";

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

export function decodeWagerMessage(
  body: string,
): InboxEnvelope<SubmitWagerInput> {
  const envelope = objectValue(JSON.parse(body));

  const messageId = text(envelope, "messageId", 200);
  const type = text(envelope, "type", 100);
  const occurredAt = text(envelope, "occurredAt", 50);

  if (type !== "WagerTransactionRequested") {
    throw new Error("Tipo de mensagem não suportado.");
  }

  if (
    !isISO8601(occurredAt, {
      strict: true,
      strictSeparator: true,
    }) ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    throw new Error("occurredAt deve ser uma data ISO-8601 válida.");
  }

  const data = objectValue(envelope.data);
  const money = objectValue(data.money);

  const playerId = text(data, "playerId", 36);
  const walletId = text(data, "walletId", 36);

  if (!isUUID(playerId) || !isUUID(walletId)) {
    throw new Error("playerId e walletId devem ser UUIDs.");
  }

  const kind = text(data, "kind", 20);

  const allowedKinds: WagerTransactionKind[] = [
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
    providerId: text(data, "providerId", 100),
    externalTransactionId: text(
      data,
      "externalTransactionId",
      200,
    ),
    idempotencyKey: text(data, "idempotencyKey", 300),
    playerId,
    walletId,
    roundId: text(data, "roundId", 200),
    gameId: text(data, "gameId", 200),
    kind: kind as WagerTransactionKind,
    money: { amount, currency },
    ...(data.referenceExternalTransactionId !== undefined
      ? {
          referenceExternalTransactionId: text(
            data,
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
    decodeWagerMessage,
    async (em, payload) => {
      const processor = new MikroOrmWagerProcessor(orm, em);

      await new SubmitWager(processor).execute(payload);
    },
  );
}
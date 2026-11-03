import { Money, type MoneyProps } from "../domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import {
  InvalidWagerTransactionError,
  WagerTransactionKind,
} from "../domain/wager-transaction.types";
import { canonicalPayloadHash } from "./canonical-payload-hash";
import type {
  WagerProcessor,
  WagerProcessingResult,
} from "./ports/wager-processor";

export interface SubmitWagerInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

export class SubmitWager {
  constructor(private readonly processor: WagerProcessor) {}

  async execute(
    input: SubmitWagerInput,
  ): Promise<WagerProcessingResult> {
    if (input.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        "OPENING é uma operação exclusivamente interna.",
      );
    }

    const money = Money.from(input.money);

    const payloadHash = canonicalPayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: {
        amount: money.toString(),
        currency: money.currency,
      },
      ...(input.referenceExternalTransactionId !== undefined
        ? {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }
        : {}),
    });

    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      createdAt: new Date(),
      ...(input.referenceExternalTransactionId !== undefined
        ? {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }
        : {}),
    });

    return this.processor.process(transaction);
  }
}
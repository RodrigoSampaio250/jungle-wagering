import { describe, expect, test } from "bun:test";
import { SubmitWager } from "../../src/application/submit-wager";
import type {
  WagerProcessor,
  WagerProcessingResult,
} from "../../src/application/ports/wager-processor";
import type { WagerTransaction } from "../../src/domain/wager-transaction";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction.types";

class CapturingProcessor implements WagerProcessor {
  readonly transactions: WagerTransaction[] = [];

  async process(
    transaction: WagerTransaction,
  ): Promise<WagerProcessingResult> {
    this.transactions.push(transaction);

    return {
      transactionId: transaction.id,
      status: WagerTransactionStatus.Pending,
      balance: null,
      failureCode: null,
      idempotentReplay: false,
    };
  }
}

function input() {
  return {
    providerId: "provider-a",
    externalTransactionId: "bet-001",
    idempotencyKey: "request-001",
    playerId: "00000000-0000-4000-8000-000000000001",
    walletId: "00000000-0000-4000-8000-000000000002",
    roundId: "round-001",
    gameId: "game-001",
    kind: WagerTransactionKind.Bet,
    money: {
      amount: "25",
      currency: "BRL",
    },
  };
}

describe("SubmitWager", () => {
  test("normaliza o dinheiro antes de entregar ao processador", async () => {
    const processor = new CapturingProcessor();
    const useCase = new SubmitWager(processor);

    const result = await useCase.execute(input());
    const transaction = processor.transactions[0];

    expect(transaction).toBeDefined();

    if (!transaction) {
        throw new Error("O processador não recebeu a transação.");
    }

    expect(transaction.money.toJSON()).toEqual({
        amount: "25.00",
        currency: "BRL",
    });

    expect(result.transactionId).toBe(transaction.id);
    });

  test("a chave de idempotência não altera o hash do negócio", async () => {
    const processor = new CapturingProcessor();
    const useCase = new SubmitWager(processor);

    await useCase.execute(input());
    await useCase.execute({
      ...input(),
      idempotencyKey: "request-002",
      money: {
        amount: "25.00",
        currency: "BRL",
      },
    });

    expect(processor.transactions).toHaveLength(2);
    expect(processor.transactions[0]?.payloadHash).toBe(
      processor.transactions[1]?.payloadHash,
    );
  });

  test("alterar o valor altera o hash do negócio", async () => {
    const processor = new CapturingProcessor();
    const useCase = new SubmitWager(processor);

    await useCase.execute(input());
    await useCase.execute({
      ...input(),
      money: {
        amount: "26.00",
        currency: "BRL",
      },
    });

    expect(processor.transactions[0]?.payloadHash).not.toBe(
      processor.transactions[1]?.payloadHash,
    );
  });

  test("rejeita OPENING externo antes de chamar o processador", async () => {
    const processor = new CapturingProcessor();
    const useCase = new SubmitWager(processor);

    await expect(
      useCase.execute({
        ...input(),
        kind: WagerTransactionKind.Opening,
      }),
    ).rejects.toThrow();

    expect(processor.transactions).toHaveLength(0);
  });
});
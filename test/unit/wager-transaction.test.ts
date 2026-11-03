import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from "../../src/domain/wager-transaction";
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction.types";

const at = new Date("2026-11-03T12:00:00.000Z");

function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: "transaction-1",
    providerId: "provider-a",
    externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1",
    payloadHash: "a".repeat(64),
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    createdAt: at,
    ...overrides,
  };
}

describe("WagerTransaction", () => {
  test("nasce pendente e compara o hash do payload", () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.matchesPayload("a".repeat(64))).toBe(true);
    expect(transaction.matchesPayload("b".repeat(64))).toBe(false);
  });

  test.each([Kind.Refund, Kind.Rollback])(
    "%s exige referência",
    (kind) => {
      expect(() =>
        WagerTransaction.create(props({ kind })),
      ).toThrow();
    },
  );

  test("rejeita referência à própria transação", () => {
    expect(() =>
      WagerTransaction.create(
        props({
          kind: Kind.Refund,
          referenceExternalTransactionId: "external-1",
        }),
      ),
    ).toThrow();
  });

  test("aguarda referência e depois processa", () => {
    const transaction = WagerTransaction.create(
      props({
        kind: Kind.Refund,
        referenceExternalTransactionId: "external-bet",
      }),
    );

    transaction.markPendingReference();
    transaction.markPendingReference();

    expect(transaction.status).toBe(Status.PendingReference);

    transaction.markProcessed("internal-bet", at);

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId).toBe("internal-bet");
    expect(transaction.processedAt?.toISOString())
      .toBe(at.toISOString());
  });

  test("não processa uma referência ainda não resolvida", () => {
    const transaction = WagerTransaction.create(
      props({
        kind: Kind.Rollback,
        referenceExternalTransactionId: "external-bet",
      }),
    );

    expect(() =>
      transaction.markProcessed(undefined, at),
    ).toThrow();

    expect(transaction.status).toBe(Status.Pending);
  });

  test("não aguarda referência quando ela não foi declarada", () => {
    const transaction = WagerTransaction.create(props());

    expect(() => transaction.markPendingReference()).toThrow();
    expect(transaction.status).toBe(Status.Pending);
  });

  test.each([
    Status.Processed,
    Status.Rejected,
    Status.Failed,
  ])("bloqueia todas as transições após %s", (status) => {
    const transaction = WagerTransaction.create(props());

    if (status === Status.Processed) {
      transaction.markProcessed(undefined, at);
    } else if (status === Status.Rejected) {
      transaction.reject(FailureCode.InsufficientBalance);
    } else {
      transaction.fail(FailureCode.PermanentInfrastructureFailure);
    }

    expect(transaction.isTerminal()).toBe(true);

    expect(() =>
      transaction.markProcessed(undefined, at),
    ).toThrow(InvalidTransactionStateError);

    expect(() =>
      transaction.markPendingReference(),
    ).toThrow(InvalidTransactionStateError);

    expect(() =>
      transaction.reject(FailureCode.ReferenceExpired),
    ).toThrow(InvalidTransactionStateError);

    expect(() =>
      transaction.fail(FailureCode.PermanentInfrastructureFailure),
    ).toThrow(InvalidTransactionStateError);

    expect(transaction.status).toBe(status);
  });

  test("registra código de rejeição e não afeta saldo", () => {
    const transaction = WagerTransaction.create(props());

    transaction.reject(FailureCode.InsufficientBalance);

    expect(transaction.failureCode)
      .toBe(FailureCode.InsufficientBalance);
    expect(transaction.affectsBalance()).toBe(false);
  });

  test.each([
    [Kind.Bet, LedgerDirection.Debit],
    [Kind.Win, LedgerDirection.Credit],
    [Kind.Opening, LedgerDirection.Credit],
    [Kind.Refund, LedgerDirection.Credit],
  ] as const)("%s possui direção %s", (kind, direction) => {
    const transaction = WagerTransaction.create(
      props({
        kind,
        ...(kind === Kind.Refund
          ? { referenceExternalTransactionId: "external-bet" }
          : {}),
      }),
    );

    expect(transaction.ledgerDirectionFor()).toBe(direction);
  });

  test("LOSS pode ter valor zero e não gera ledger", () => {
    const transaction = WagerTransaction.create(
      props({
        kind: Kind.Loss,
        money: Money.zero("BRL"),
      }),
    );

    transaction.markProcessed(undefined, at);

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.affectsBalance()).toBe(false);
    expect(() => transaction.ledgerDirectionFor()).toThrow();
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ] as const)(
    "ROLLBACK de %s produz %s",
    (kind, direction) => {
      const reference = WagerTransaction.create(
        props({
          kind,
          ...(kind === Kind.Refund
            ? { referenceExternalTransactionId: "original-bet" }
            : {}),
        }),
      );

      reference.markProcessed(
        kind === Kind.Refund ? "internal-original-bet" : undefined,
        at,
      );

      const rollback = WagerTransaction.create(
        props({
          id: "rollback-1",
          externalTransactionId: "external-rollback",
          kind: Kind.Rollback,
          referenceExternalTransactionId: "external-1",
        }),
      );

      expect(rollback.ledgerDirectionFor(reference))
        .toBe(direction);
    },
  );

  test("ROLLBACK rejeita referência pendente", () => {
    const reference = WagerTransaction.create(props());
    const rollback = WagerTransaction.create(
      props({
        kind: Kind.Rollback,
        externalTransactionId: "external-rollback",
        referenceExternalTransactionId: "external-1",
      }),
    );

    expect(() => rollback.ledgerDirectionFor(reference)).toThrow();
  });

  test("rejeita valor zero para BET", () => {
    expect(() =>
      WagerTransaction.create(
        props({ money: Money.zero("BRL") }),
      ),
    ).toThrow();
  });

  test("reidrata uma transação rejeitada com seu código", () => {
    const transaction = WagerTransaction.rehydrate({
      ...props(),
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientBalance,
    });

    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode)
      .toBe(FailureCode.InsufficientBalance);
    expect(transaction.isTerminal()).toBe(true);
  });
});
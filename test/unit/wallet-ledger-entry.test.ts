import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
  type LedgerEntryState,
} from "../../src/domain/wallet-ledger-entry";

const brl = (amount: string): Money =>
  Money.from({ amount, currency: "BRL" });

function validDebit(): LedgerEntryState {
  return {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "transaction-1",
    direction: LedgerDirection.Debit,
    money: brl("25.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("75.00"),
    createdAt: new Date("2026-11-03T12:00:00.000Z"),
  };
}

describe("WalletLedgerEntry", () => {
  test("cria débito com aritmética correta", () => {
    const entry = WalletLedgerEntry.create(validDebit());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe("75.00");
  });

  test("cria crédito com aritmética correta", () => {
    const entry = WalletLedgerEntry.create({
      ...validDebit(),
      direction: LedgerDirection.Credit,
      balanceAfter: brl("125.00"),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test("permite débito que zera o saldo", () => {
    const entry = WalletLedgerEntry.create({
      ...validDebit(),
      money: brl("100.00"),
      balanceAfter: brl("0.00"),
    });

    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test("rejeita saldo posterior incompatível com a movimentação", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceAfter: brl("80.00"),
      }),
    ).toThrow();
  });

  test("rejeita lançamento com valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        money: brl("0.00"),
        balanceAfter: brl("100.00"),
      }),
    ).toThrow();
  });

  test("rejeita lançamento com valor negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        money: brl("25.00").negate(),
      }),
    ).toThrow();
  });

  test("rejeita saldo anterior ou posterior negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceBefore: brl("1.00").negate(),
      }),
    ).toThrow();

    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceAfter: brl("1.00").negate(),
      }),
    ).toThrow();
  });

  test("rejeita moeda diferente no valor ou no saldo posterior", () => {
    const usd = Money.from({
      amount: "25.00",
      currency: "USD",
    });

    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        money: usd,
      }),
    ).toThrow();

    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceAfter: usd,
      }),
    ).toThrow();
  });

  test.each(["id", "walletId", "transactionId"] as const)(
    "rejeita identificador vazio em %s",
    (field) => {
      expect(() =>
        WalletLedgerEntry.create({
          ...validDebit(),
          [field]: " ",
        }),
      ).toThrow();
    },
  );

  test("rejeita data inválida", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        createdAt: new Date("invalid"),
      }),
    ).toThrow();
  });

  test("protege a data contra alterações externas", () => {
    const state = validDebit();
    const entry = WalletLedgerEntry.create(state);
    const expected = "2026-11-03T12:00:00.000Z";

    state.createdAt.setUTCFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe(expected);

    const returnedDate = entry.createdAt;
    returnedDate.setUTCFullYear(2001);
    expect(entry.createdAt.toISOString()).toBe(expected);
  });

  test("mantém o lançamento congelado", () => {
    const entry = WalletLedgerEntry.create(validDebit());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.set(entry, "id", "changed")).toBe(false);
    expect(entry.id).toBe("entry-1");
  });

  test("reidrata um lançamento persistido", () => {
    const entry = WalletLedgerEntry.rehydrate(validDebit());

    expect(entry.id).toBe("entry-1");
    expect(entry.isBalanced()).toBe(true);
    expect(entry.createdAt.toISOString())
      .toBe("2026-11-03T12:00:00.000Z");
  });
});
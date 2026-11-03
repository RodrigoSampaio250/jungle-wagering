import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  InsufficientBalanceError,
  Wallet,
  type WalletMovement,
} from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";

const brl = (amount: string): Money =>
  Money.from({ amount, currency: "BRL" });

const openedAt = new Date("2026-11-03T12:00:00.000Z");
const movedAt = new Date("2026-11-03T12:01:00.000Z");

function openWallet(amount = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(amount),
    at: openedAt,
  });
}

function movement(amount: string): WalletMovement {
  return {
    entryId: "entry-1",
    transactionId: "transaction-1",
    money: brl(amount),
    at: movedAt,
  };
}

describe("Wallet", () => {
  test("abre com saldo inicial e versão 1", () => {
    const wallet = openWallet();

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.createdAt.toISOString())
      .toBe(openedAt.toISOString());
  });

  test("permite abertura com saldo zero", () => {
    const wallet = openWallet("0.00");

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test("rejeita abertura com saldo negativo", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: brl("1.00").negate(),
      }),
    ).toThrow();
  });

  test("debita e retorna lançamento correspondente", () => {
    const wallet = openWallet();
    const entry = wallet.debit(movement("80.00"));

    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString())
      .toBe(movedAt.toISOString());

    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe("transaction-1");
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test("credita e retorna lançamento correspondente", () => {
    const wallet = openWallet();
    const entry = wallet.credit(movement("25.50"));

    expect(wallet.balance.toString()).toBe("125.50");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test("permite debitar o saldo inteiro", () => {
    const wallet = openWallet();

    wallet.debit(movement("100.00"));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test("rejeita débito sem saldo e preserva o estado", () => {
    const wallet = openWallet();

    expect(() =>
      wallet.debit(movement("100.01")),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString())
      .toBe(openedAt.toISOString());
  });

  test("segunda aposta sequencial sem saldo é rejeitada", () => {
    const wallet = openWallet();

    wallet.debit(movement("80.00"));

    expect(() =>
      wallet.debit({
        ...movement("80.00"),
        entryId: "entry-2",
        transactionId: "transaction-2",
      }),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test.each(["debit", "credit"] as const)(
    "%s rejeita moeda diferente sem alterar estado",
    (method) => {
      const wallet = openWallet();

      expect(() =>
        wallet[method]({
          ...movement("1.00"),
          money: Money.from({
            amount: "1.00",
            currency: "USD",
          }),
        }),
      ).toThrow();

      expect(wallet.balance.toString()).toBe("100.00");
      expect(wallet.version).toBe(1);
    },
  );

  test.each(["debit", "credit"] as const)(
    "%s rejeita zero e valor negativo",
    (method) => {
      const wallet = openWallet();

      expect(() =>
        wallet[method](movement("0.00")),
      ).toThrow();

      expect(() =>
        wallet[method]({
          ...movement("1.00"),
          money: brl("1.00").negate(),
        }),
      ).toThrow();

      expect(wallet.balance.toString()).toBe("100.00");
      expect(wallet.version).toBe(1);
    },
  );

  test("falha na criação do ledger preserva a wallet", () => {
    const wallet = openWallet();

    expect(() =>
      wallet.debit({
        ...movement("25.00"),
        entryId: "",
      }),
    ).toThrow();

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString())
      .toBe(openedAt.toISOString());
  });

  test("estouro no crédito preserva o estado", () => {
    const wallet = openWallet("999999999999999999.99");

    expect(() =>
      wallet.credit(movement("0.01")),
    ).toThrow();

    expect(wallet.balance.toString())
      .toBe("999999999999999999.99");
    expect(wallet.version).toBe(1);
  });

  test("protege as datas contra alterações externas", () => {
    const date = new Date(openedAt);
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      at: date,
    });

    date.setUTCFullYear(2000);
    wallet.createdAt.setUTCFullYear(2001);
    wallet.updatedAt.setUTCFullYear(2002);

    expect(wallet.createdAt.toISOString())
      .toBe(openedAt.toISOString());
    expect(wallet.updatedAt.toISOString())
      .toBe(openedAt.toISOString());
  });

  test("reidrata saldo e versão persistidos", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: brl("75.00"),
      version: 4,
      createdAt: openedAt,
      updatedAt: movedAt,
    });

    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(4);
  });
});

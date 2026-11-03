import { Money } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLedgerEntryError";
  }
}

export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;

  private readonly createdAtIso: string;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAtIso = state.createdAt.toISOString();

    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (
      !state.id.trim() ||
      !state.walletId.trim() ||
      !state.transactionId.trim()
    ) {
      throw new InvalidLedgerEntryError(
        "Os identificadores do lançamento são obrigatórios.",
      );
    }

    if (
      state.direction !== LedgerDirection.Debit &&
      state.direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError("Direção inválida.");
    }

    if (!state.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        "O valor do lançamento deve ser positivo.",
      );
    }

    if (
      state.balanceBefore.isNegative() ||
      state.balanceAfter.isNegative()
    ) {
      throw new InvalidLedgerEntryError(
        "Os saldos do lançamento não podem ser negativos.",
      );
    }

    if (!Number.isFinite(state.createdAt.getTime())) {
      throw new InvalidLedgerEntryError("Data inválida.");
    }

    const entry = new WalletLedgerEntry(state);

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        "O lançamento não corresponde à alteração de saldo.",
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.createdAtIso);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}
import { CurrencyMismatchError, Money } from "./money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "./wallet-ledger-entry";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletMovement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWalletError";
  }
}

export class InsufficientBalanceError extends Error {
  constructor() {
    super("Saldo insuficiente.");
    this.name = "InsufficientBalanceError";
  }
}

export class Wallet {
  public readonly id: string;
  public readonly playerId: string;
  public readonly currency: string;

  private _balance: Money;
  private _version: number;
  private readonly createdAtIso: string;
  private updatedAtIso: string;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this._balance = state.balance;
    this._version = state.version;
    this.createdAtIso = state.createdAt.toISOString();
    this.updatedAtIso = state.updatedAt.toISOString();
  }

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new InvalidWalletError(
        "Os identificadores da wallet são obrigatórios.",
      );
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError(
        "O saldo inicial não pode ser negativo.",
      );
    }

    const at = props.at ?? new Date();

    if (!Number.isFinite(at.getTime())) {
      throw new InvalidWalletError("Data inválida.");
    }

    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtIso);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtIso);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.applyMovement(movement, LedgerDirection.Debit);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.applyMovement(movement, LedgerDirection.Credit);
  }

  private applyMovement(
    movement: WalletMovement,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);

    if (!movement.money.isPositive()) {
      throw new InvalidWalletError(
        "O valor da movimentação deve ser positivo.",
      );
    }

    if (
      direction === LedgerDirection.Debit &&
      this._balance.isLessThan(movement.money)
    ) {
      throw new InsufficientBalanceError();
    }

    const balanceAfter =
      direction === LedgerDirection.Debit
        ? this._balance.subtract(movement.money)
        : this._balance.add(movement.money);

    // Valida o lançamento antes de alterar o estado da wallet.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this.updatedAtIso = movement.at.toISOString();

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
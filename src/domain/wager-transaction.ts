import { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction.types";

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState
  extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;

  private readonly createdAtIso: string;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private processedAtIso: string | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId =
      state.referenceExternalTransactionId;
    this.createdAtIso = state.createdAt.toISOString();
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this.processedAtIso = state.processedAt?.toISOString();
  }

  static create(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    const identifiers = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (identifiers.some((value) => !value.trim())) {
      throw new InvalidWagerTransactionError(
        "Os identificadores da transação são obrigatórios.",
      );
    }

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(
        "Tipo de transação inválido.",
      );
    }

    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError(
        "O payloadHash deve ser um SHA-256 hexadecimal.",
      );
    }

    if (!Number.isFinite(props.createdAt.getTime())) {
      throw new InvalidWagerTransactionError("Data inválida.");
    }

    if (
      props.money.isNegative() ||
      (props.kind !== WagerTransactionKind.Loss &&
        !props.money.isPositive())
    ) {
      throw new InvalidWagerTransactionError(
        "Operações financeiras exigem valor positivo.",
      );
    }

    if (
      props.referenceExternalTransactionId !== undefined &&
      !props.referenceExternalTransactionId.trim()
    ) {
      throw new InvalidWagerTransactionError(
        "A referência não pode ser vazia.",
      );
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(
        "REFUND e ROLLBACK exigem referência.",
      );
    }

    if (
      props.referenceExternalTransactionId ===
      props.externalTransactionId
    ) {
      throw new InvalidWagerTransactionError(
        "Uma transação não pode referenciar a si mesma.",
      );
    }

    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
    });
  }

  static rehydrate(
    state: WagerTransactionState,
  ): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return new Date(this.createdAtIso);
  }

  get processedAt(): Date | undefined {
    return this.processedAtIso === undefined
      ? undefined
      : new Date(this.processedAtIso);
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
  ): void {
    this.assertNotTerminal();

    if (!Number.isFinite(at.getTime())) {
      throw new InvalidWagerTransactionError("Data inválida.");
    }

    if (
      referenceTransactionId !== undefined &&
      !referenceTransactionId.trim()
    ) {
      throw new InvalidWagerTransactionError(
        "Identificador de referência inválido.",
      );
    }

    if (
      this.referenceExternalTransactionId !== undefined &&
      referenceTransactionId === undefined
    ) {
      throw new InvalidWagerTransactionError(
        "A referência precisa ser resolvida antes do processamento.",
      );
    }

    if (
      this.referenceExternalTransactionId === undefined &&
      referenceTransactionId !== undefined
    ) {
      throw new InvalidWagerTransactionError(
        "A transação não declarou uma referência.",
      );
    }

    this._referenceTransactionId = referenceTransactionId;
    this.processedAtIso = at.toISOString();
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertNotTerminal();

    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        "A transação não possui referência para aguardar.",
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return (
      this.kind !== WagerTransactionKind.Loss &&
      this._status !== WagerTransactionStatus.Rejected &&
      this._status !== WagerTransactionStatus.Failed
    );
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback:
        if (
          reference === undefined ||
          reference.status !== WagerTransactionStatus.Processed
        ) {
          throw new InvalidWagerTransactionError(
            "ROLLBACK exige referência processada.",
          );
        }

        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }

        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }

        throw new InvalidWagerTransactionError(
          "Tipo de referência não permitido para ROLLBACK.",
        );

      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          "LOSS não gera lançamento no ledger.",
        );
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError();
    }
  }
}
export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export enum FailureCode {
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  InvalidProvider = "INVALID_PROVIDER",

  InsufficientBalance = "INSUFFICIENT_BALANCE",
  ReversalInsufficientBalance = "REVERSAL_INSUFFICIENT_BALANCE",

  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReferenceExpired = "REFERENCE_EXPIRED",

  PermanentInfrastructureFailure = "PERMANENT_INFRASTRUCTURE_FAILURE",
}

export class InvalidTransactionStateError extends Error {
  constructor() {
    super("Uma transação terminal não pode mudar de estado.");
    this.name = "InvalidTransactionStateError";
  }
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionError";
  }
}
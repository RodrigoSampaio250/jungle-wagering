import type { MoneyProps } from "../../domain/money";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { FailureCode } from "../../domain/wager-transaction.types";
import type { WagerTransactionStatus } from "../../domain/wager-transaction.types";

export interface WagerProcessingResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps | null;
  readonly failureCode: FailureCode | null;
  readonly idempotentReplay: boolean;
}

export interface WagerProcessor {
  /**
   * Processa e persiste a operação atomicamente.
   * Replays devem recuperar o resultado persistido.
   */
  process(
    transaction: WagerTransaction,
  ): Promise<WagerProcessingResult>;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("A chave de idempotência já possui outro payload.");
    this.name = "IdempotencyConflictError";
  }
}

export class ExternalTransactionConflictError extends Error {
  constructor() {
    super("O identificador externo já foi usado com outra chave.");
    this.name = "ExternalTransactionConflictError";
  }
}
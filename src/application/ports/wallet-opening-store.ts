import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WagerTransaction } from "../../domain/wager-transaction";

export interface WalletOpening {
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction | undefined;
  readonly entry: WalletLedgerEntry | undefined;
}

export interface WalletOpeningStore {
  /**
   * Salva todos os registros na mesma transação SQL.
   * Em qualquer falha, nenhuma gravação deve permanecer.
   */
  save(opening: WalletOpening): Promise<void>;
}

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super("Já existe uma wallet para este jogador e moeda.");
    this.name = "WalletAlreadyExistsError";
  }
}
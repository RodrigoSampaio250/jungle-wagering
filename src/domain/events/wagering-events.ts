import type { MoneyProps } from "../money";
import type { LedgerDirection } from "../wallet-ledger-entry";
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../wager-transaction.types";
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from "./integration-event";

export interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly money: MoneyProps;
  readonly balance: MoneyProps | null;
  readonly failureCode: FailureCode | null;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WagerTransactionProcessed
  extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static create(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}

export class WagerTransactionRejected
  extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static create(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}

export class WagerTransactionPendingReference
  extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static create(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}

export class WalletBalanceChanged
  extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WalletBalanceChangedData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static create(
    props: IntegrationEventProps<WalletBalanceChangedData>,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}
export class WagerTransactionFailed
  extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static create(
    props: IntegrationEventProps<WagerTransactionEventData>,
  ): WagerTransactionFailed {
    return new WagerTransactionFailed(props);
  }
}
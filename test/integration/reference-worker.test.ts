import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/create-wallet";
import {
  SubmitWager,
  type SubmitWagerInput,
} from "../../src/application/submit-wager";
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction.types";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmWalletOpeningStore } from "../../src/infrastructure/database/mikro-orm-wallet-opening.store";
import { MikroOrmWagerProcessor } from "../../src/infrastructure/database/mikro-orm-wager-processor";
import { ReferenceWorker } from "../../src/infrastructure/database/reference-worker";
import { WalletRecord } from "../../src/infrastructure/database/wallet.record";
import { WalletLedgerEntryRecord } from "../../src/infrastructure/database/wallet-ledger-entry.record";
import { WagerTransactionRecord } from "../../src/infrastructure/database/wager-transaction.record";
import { OutboxEventRecord } from "../../src/infrastructure/database/outbox-event.record";

const databaseName =
  `wagering_test_${crypto.randomUUID().replaceAll("-", "")}`;

let admin: MikroORM | undefined;
let orm: MikroORM | undefined;
let databaseCreated = false;

function database(): MikroORM {
  if (!orm) {
    throw new Error("Banco de teste não inicializado.");
  }

  return orm;
}

beforeAll(async () => {
  admin = await MikroORM.init(config);

  await admin.em.getConnection().execute(
    `CREATE DATABASE "${databaseName}"`,
  );
  databaseCreated = true;

  const url = new URL(config.clientUrl!);
  url.pathname = `/${databaseName}`;

  orm = await MikroORM.init({
    ...config,
    clientUrl: url.toString(),
  });

  await orm.getMigrator().up();
}, 30_000);

afterAll(async () => {
  try {
    await orm?.close(true);
  } finally {
    try {
      if (admin && databaseCreated) {
        await admin.em.getConnection().execute(
          `DROP DATABASE "${databaseName}" WITH (FORCE)`,
        );
      }
    } finally {
      await admin?.close(true);
    }
  }
}, 30_000);

async function fixture() {
  const playerId = crypto.randomUUID();

  const wallet = await new CreateWallet(
    new MikroOrmWalletOpeningStore(database()),
  ).execute({
    playerId,
    initialBalance: {
      amount: "100.00",
      currency: "BRL",
    },
  });

  const bet: SubmitWagerInput = {
    providerId: "provider-reference-test",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    playerId,
    walletId: wallet.id,
    roundId: crypto.randomUUID(),
    gameId: "game-test",
    kind: Kind.Bet,
    money: {
      amount: "25.00",
      currency: "BRL",
    },
  };

  const refund: SubmitWagerInput = {
    ...bet,
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    kind: Kind.Refund,
    referenceExternalTransactionId: bet.externalTransactionId,
  };

  const submit = new SubmitWager(
    new MikroOrmWagerProcessor(database()),
  );

  return { wallet, bet, refund, submit };
}

async function makeDue(transactionId: string) {
  await database().em.fork().nativeUpdate(
    WagerTransactionRecord,
    { id: transactionId },
    { nextReferenceAttemptAt: new Date(0) },
  );
}

describe("ReferenceWorker — PostgreSQL real", () => {
  test("sem referência, agenda outra tentativa sem repetir evento nem movimentar saldo", async () => {
    const { wallet, refund, submit } = await fixture();
    const pending = await submit.execute(refund);

    expect(pending.status).toBe(Status.PendingReference);

    await makeDue(pending.transactionId);

    const before = Date.now();

    expect(
      await new ReferenceWorker(
        database(),
        3_600_000,
      ).processOne(),
    ).toBe("retry");

    const em = database().em.fork();

    const transaction = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: pending.transactionId },
    );

    expect(transaction.status).toBe(Status.PendingReference);
    expect(transaction.referenceAttempts).toBe(1);
    expect(
      transaction.nextReferenceAttemptAt!.getTime(),
    ).toBeGreaterThanOrEqual(before + 2_000);

    const currentWallet = await em.findOneOrFail(
      WalletRecord,
      { id: wallet.id },
    );

    expect(currentWallet.balance).toBe("100.00");
    expect(currentWallet.version).toBe(1);

    expect(
      await em.count(WalletLedgerEntryRecord, {
        walletId: wallet.id,
      }),
    ).toBe(1);

    const pendingEvents = await em.find(
      OutboxEventRecord,
      { aggregateId: pending.transactionId },
    );

    expect(
      pendingEvents.map((event) => event.eventType),
    ).toEqual([
      "WagerTransactionPendingReference",
    ]);

    expect(pendingEvents[0]?.payload).toMatchObject({
      aggregateId: pending.transactionId,
      correlationId: pending.transactionId,
      version: 1,
      data: {
        transactionId: pending.transactionId,
        walletId: wallet.id,
        status: "PENDING_REFERENCE",
        referenceExternalTransactionId:
          refund.referenceExternalTransactionId,
      },
    });

    // Evita que este registro participe dos próximos testes.
    await em.nativeUpdate(
      WagerTransactionRecord,
      { id: pending.transactionId },
      {
        nextReferenceAttemptAt: new Date(
          Date.now() + 3_600_000,
        ),
      },
    );
  });

  test("processa o estorno quando a aposta chega depois, uma única vez", async () => {
    const { wallet, bet, refund, submit } = await fixture();

    const pending = await submit.execute(refund);
    expect(pending.status).toBe(Status.PendingReference);

    const original = await submit.execute(bet);
    expect(original.balance?.amount).toBe("75.00");

    await makeDue(pending.transactionId);

    const worker = new ReferenceWorker(
      database(),
      3_600_000,
    );

    const results = await Promise.all([
      worker.processOne(),
      worker.processOne(),
    ]);

    expect(
      results.filter((result) => result === "processed"),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result === "empty"),
    ).toHaveLength(1);

    const em = database().em.fork();

    const transaction = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: pending.transactionId },
    );

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId).toBe(
      original.transactionId,
    );
    expect(transaction.nextReferenceAttemptAt).toBeNull();

    const updatedWallet = await em.findOneOrFail(
      WalletRecord,
      { id: wallet.id },
    );

    expect(updatedWallet.balance).toBe("100.00");
    expect(updatedWallet.version).toBe(3);

    expect(
      await em.count(WalletLedgerEntryRecord, {
        transactionId: pending.transactionId,
      }),
    ).toBe(1);

    const resolvedEvents = await em.find(
      OutboxEventRecord,
      { aggregateId: pending.transactionId },
    );

    expect(
      resolvedEvents.map((event) => event.eventType).sort(),
    ).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    const balanceChanged = resolvedEvents.find(
      (event) => event.eventType === "WalletBalanceChanged",
    );

    expect(balanceChanged?.payload).toMatchObject({
      data: {
        transactionId: pending.transactionId,
        walletId: wallet.id,
        direction: "CREDIT",
        money: {
          amount: "25.00",
          currency: "BRL",
        },
        balanceBefore: {
          amount: "75.00",
          currency: "BRL",
        },
        balanceAfter: {
          amount: "100.00",
          currency: "BRL",
        },
        walletVersion: 3,
      },
    });
  });

  test("prazo expirado rejeita e gera evento sem movimentar saldo", async () => {
    const { wallet, refund, submit } = await fixture();
    const pending = await submit.execute(refund);

    await database().em.fork().nativeUpdate(
      WagerTransactionRecord,
      { id: pending.transactionId },
      {
        createdAt: new Date(Date.now() - 7_200_000),
        nextReferenceAttemptAt: new Date(
          Date.now() + 3_600_000,
        ),
      },
    );

    expect(
      await new ReferenceWorker(
        database(),
        3_600_000,
      ).processOne(),
    ).toBe("expired");

    const em = database().em.fork();

    const transaction = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: pending.transactionId },
    );

    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode).toBe(
      FailureCode.ReferenceExpired,
    );
    expect(transaction.nextReferenceAttemptAt).toBeNull();

    const currentWallet = await em.findOneOrFail(
      WalletRecord,
      { id: wallet.id },
    );

    expect(currentWallet.balance).toBe("100.00");
    expect(currentWallet.version).toBe(1);

    expect(
      await em.count(WalletLedgerEntryRecord, {
        transactionId: pending.transactionId,
      }),
    ).toBe(0);

    const events = await em.find(
      OutboxEventRecord,
      { aggregateId: pending.transactionId },
    );

    expect(
      events.map((event) => event.eventType).sort(),
    ).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);

    const rejected = events.find(
      (event) => event.eventType === "WagerTransactionRejected",
    );

    expect(rejected?.payload).toMatchObject({
      data: {
        transactionId: pending.transactionId,
        walletId: wallet.id,
        status: "REJECTED",
        failureCode: "REFERENCE_EXPIRED",
      },
    });
  });
});
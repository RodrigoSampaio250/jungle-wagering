import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  CreateWallet,
  type CreateWalletResult,
} from "../../src/application/create-wallet";
import { SubmitWager } from "../../src/application/submit-wager";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../../src/application/ports/wager-processor";
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction.types";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmWalletOpeningStore } from "../../src/infrastructure/database/mikro-orm-wallet-opening.store";
import { MikroOrmWagerProcessor } from "../../src/infrastructure/database/mikro-orm-wager-processor";
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
    if (orm) {
      await orm.close(true);
    }

    if (admin && databaseCreated) {
      await admin.em.getConnection().execute(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    }
  } finally {
    if (admin) {
      await admin.close(true);
    }
  }
}, 30_000);

async function openWallet(): Promise<CreateWalletResult> {
  return new CreateWallet(
    new MikroOrmWalletOpeningStore(database()),
  ).execute({
    playerId: crypto.randomUUID(),
    initialBalance: {
      amount: "100.00",
      currency: "BRL",
    },
  });
}

function submit(): SubmitWager {
  // Instâncias distintas compartilham apenas o banco.
  return new SubmitWager(
    new MikroOrmWagerProcessor(database()),
  );
}

function bet(wallet: CreateWalletResult) {
  return {
    providerId: "provider-a",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-001",
    gameId: "game-001",
    kind: Kind.Bet,
    money: {
      amount: "25.00",
      currency: "BRL",
    },
  };
}

async function state(walletId: string) {
  const rows = await database().em.fork().execute<
    {
      balance: string;
      version: number;
      entries: string;
      wagers: string;
      ledger_balance: string;
    }[]
  >(
    `SELECT
      w.balance,
      w.version,
      (
        SELECT count(*)
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS entries,
      (
        SELECT count(*)
        FROM wager_transactions
        WHERE wallet_id = w.id AND kind <> 'OPENING'
      ) AS wagers,
      (
        SELECT COALESCE(SUM(
          CASE WHEN direction = 'CREDIT'
            THEN amount ELSE -amount END
        ), 0)::numeric(20,2)
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS ledger_balance
    FROM wallets w
    WHERE w.id = ?`,
    [walletId],
  );

  const row = rows[0];

  if (!row) {
    throw new Error("Carteira não encontrada.");
  }

  return row;
}

describe("ProcessWager — PostgreSQL real", () => {
  test("50 apostas duplicadas produzem um único débito", async () => {
    const wallet = await openWallet();
    const input = bet(wallet);

    const results = await Promise.all(
      Array.from(
        { length: 50 },
        () => submit().execute(input),
      ),
    );

    expect(
      results.every((result) => result.status === Status.Processed),
    ).toBe(true);

    expect(
      new Set(results.map((result) => result.transactionId)).size,
    ).toBe(1);

    expect(
      results.filter((result) => !result.idempotentReplay),
    ).toHaveLength(1);

    expect(
      results.every(
        (result) => result.balance?.amount === "75.00",
      ),
    ).toBe(true);

    expect(await state(wallet.id)).toEqual({
      balance: "75.00",
      version: 2,
      entries: "2",
      wagers: "1",
      ledger_balance: "75.00",
    });
  }, 30_000);

  test("duas apostas de 80 disputam saldo 100 sem saldo negativo", async () => {
    const wallet = await openWallet();

    const results = await Promise.all([
      submit().execute({
        ...bet(wallet),
        money: { amount: "80.00", currency: "BRL" },
      }),
      submit().execute({
        ...bet(wallet),
        money: { amount: "80.00", currency: "BRL" },
      }),
    ]);

    expect(
      results.filter((result) => result.status === Status.Processed),
    ).toHaveLength(1);

    const rejected = results.filter(
      (result) => result.status === Status.Rejected,
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe(
      FailureCode.InsufficientBalance,
    );

    expect(await state(wallet.id)).toEqual({
      balance: "20.00",
      version: 2,
      entries: "2",
      wagers: "2",
      ledger_balance: "20.00",
    });
  });

  test("replay retorna o saldo original mesmo após outra operação", async () => {
    const wallet = await openWallet();
    const input = bet(wallet);

    const original = await submit().execute(input);

    await submit().execute({
      ...bet(wallet),
      kind: Kind.Win,
      money: { amount: "10.00", currency: "BRL" },
    });

    const replay = await submit().execute(input);

    expect(original.balance?.amount).toBe("75.00");
    expect(replay.balance?.amount).toBe("75.00");
    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.idempotentReplay).toBe(true);

    const current = await state(wallet.id);
    expect(current.balance).toBe("85.00");
    expect(current.ledger_balance).toBe("85.00");
    expect(current.version).toBe(3);
  });

  test("mesma chave com outro valor gera conflito sem novo débito", async () => {
    const wallet = await openWallet();
    const input = bet(wallet);

    await submit().execute(input);

    await expect(
      submit().execute({
        ...input,
        money: { amount: "30.00", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await state(wallet.id)).toEqual({
      balance: "75.00",
      version: 2,
      entries: "2",
      wagers: "1",
      ledger_balance: "75.00",
    });
  });

  test("mesmo identificador externo com outra chave gera conflito", async () => {
    const wallet = await openWallet();
    const input = bet(wallet);

    await submit().execute(input);

    await expect(
      submit().execute({
        ...input,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ExternalTransactionConflictError);

    const current = await state(wallet.id);
    expect(current.balance).toBe("75.00");
    expect(current.wagers).toBe("1");
    expect(current.entries).toBe("2");
  });
    test("REFUND devolve o valor de uma aposta processada", async () => {
    const wallet = await openWallet();
    const original = bet(wallet);

    await submit().execute(original);

    const refund = await submit().execute({
      ...bet(wallet),
      kind: Kind.Refund,
      referenceExternalTransactionId:
        original.externalTransactionId,
    });

    expect(refund.status).toBe(Status.Processed);
    expect(refund.balance?.amount).toBe("100.00");

    expect(await state(wallet.id)).toEqual({
      balance: "100.00",
      version: 3,
      entries: "3",
      wagers: "2",
      ledger_balance: "100.00",
    });
  });

  test("dois REFUND concorrentes não devolvem a mesma aposta duas vezes", async () => {
    const wallet = await openWallet();
    const original = bet(wallet);

    await submit().execute(original);

    const results = await Promise.all([
      submit().execute({
        ...bet(wallet),
        kind: Kind.Refund,
        referenceExternalTransactionId:
          original.externalTransactionId,
      }),
      submit().execute({
        ...bet(wallet),
        kind: Kind.Refund,
        referenceExternalTransactionId:
          original.externalTransactionId,
      }),
    ]);

    expect(
      results.filter((result) => result.status === Status.Processed),
    ).toHaveLength(1);

    const rejected = results.find(
      (result) => result.status === Status.Rejected,
    );

    expect(rejected?.failureCode).toBe(
      FailureCode.ReferenceAlreadyReversed,
    );

    expect(await state(wallet.id)).toEqual({
      balance: "100.00",
      version: 3,
      entries: "3",
      wagers: "3",
      ledger_balance: "100.00",
    });
  });

  test("ROLLBACK de BET credita o valor de volta", async () => {
    const wallet = await openWallet();
    const original = bet(wallet);

    await submit().execute(original);

    const result = await submit().execute({
      ...bet(wallet),
      kind: Kind.Rollback,
      referenceExternalTransactionId:
        original.externalTransactionId,
    });

    expect(result.status).toBe(Status.Processed);
    expect(result.balance?.amount).toBe("100.00");

    const current = await state(wallet.id);
    expect(current.balance).toBe("100.00");
    expect(current.ledger_balance).toBe("100.00");
    expect(current.version).toBe(3);
    expect(current.entries).toBe("3");
  });

  test("ROLLBACK de WIN debita o crédito recebido", async () => {
    const wallet = await openWallet();
    const original = {
      ...bet(wallet),
      kind: Kind.Win,
    };

    await submit().execute(original);

    const result = await submit().execute({
      ...bet(wallet),
      kind: Kind.Rollback,
      referenceExternalTransactionId:
        original.externalTransactionId,
    });

    expect(result.status).toBe(Status.Processed);
    expect(result.balance?.amount).toBe("100.00");

    const current = await state(wallet.id);
    expect(current.balance).toBe("100.00");
    expect(current.ledger_balance).toBe("100.00");
    expect(current.version).toBe(3);
  });

  test("ROLLBACK de REFUND desfaz a devolução", async () => {
    const wallet = await openWallet();
    const original = bet(wallet);

    await submit().execute(original);

    const refundInput = {
      ...bet(wallet),
      kind: Kind.Refund,
      referenceExternalTransactionId:
        original.externalTransactionId,
    };

    await submit().execute(refundInput);

    const result = await submit().execute({
      ...bet(wallet),
      kind: Kind.Rollback,
      referenceExternalTransactionId:
        refundInput.externalTransactionId,
    });

    expect(result.status).toBe(Status.Processed);
    expect(result.balance?.amount).toBe("75.00");

    expect(await state(wallet.id)).toEqual({
      balance: "75.00",
      version: 4,
      entries: "4",
      wagers: "3",
      ledger_balance: "75.00",
    });
  });

  test("ROLLBACK sem saldo falha com código específico e sem ledger", async () => {
    const wallet = await openWallet();
    const winInput = {
      ...bet(wallet),
      kind: Kind.Win,
    };

    await submit().execute(winInput);

    await submit().execute({
      ...bet(wallet),
      money: { amount: "120.00", currency: "BRL" },
    });

    const result = await submit().execute({
      ...bet(wallet),
      kind: Kind.Rollback,
      referenceExternalTransactionId:
        winInput.externalTransactionId,
    });

    expect(result.status).toBe(Status.Failed);
    expect(result.failureCode).toBe(
      FailureCode.ReversalInsufficientBalance,
    );
    expect(result.balance?.amount).toBe("5.00");

    expect(await state(wallet.id)).toEqual({
      balance: "5.00",
      version: 3,
      entries: "3",
      wagers: "3",
      ledger_balance: "5.00",
    });
  });

  test("LOSS de valor zero não altera saldo nem versão e não gera ledger", async () => {
    const wallet = await openWallet();

    const result = await submit().execute({
      ...bet(wallet),
      kind: Kind.Loss,
      money: { amount: "0.00", currency: "BRL" },
    });

    expect(result.status).toBe(Status.Processed);
    expect(result.balance?.amount).toBe("100.00");

    expect(await state(wallet.id)).toEqual({
      balance: "100.00",
      version: 1,
      entries: "1",
      wagers: "1",
      ledger_balance: "100.00",
    });
  });

  test("referência ausente fica pendente sem movimentar saldo", async () => {
    const wallet = await openWallet();

    const input = {
      ...bet(wallet),
      kind: Kind.Refund,
      referenceExternalTransactionId: crypto.randomUUID(),
    };

    const result = await submit().execute(input);

    expect(result.status).toBe(Status.PendingReference);
    expect(result.failureCode).toBeNull();
    expect(result.balance?.amount).toBe("100.00");

    const replay = await submit().execute(input);

    expect(replay.transactionId).toBe(result.transactionId);
    expect(replay.status).toBe(Status.PendingReference);
    expect(replay.idempotentReplay).toBe(true);

    expect(await state(wallet.id)).toEqual({
      balance: "100.00",
      version: 1,
      entries: "1",
      wagers: "1",
      ledger_balance: "100.00",
    });
  });

  test("REFUND com valor diferente da aposta é rejeitado", async () => {
    const wallet = await openWallet();
    const original = bet(wallet);

    await submit().execute(original);

    const result = await submit().execute({
      ...bet(wallet),
      kind: Kind.Refund,
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId:
        original.externalTransactionId,
    });

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(
      FailureCode.ReferenceAmountMismatch,
    );

    const current = await state(wallet.id);
    expect(current.balance).toBe("75.00");
    expect(current.ledger_balance).toBe("75.00");
    expect(current.version).toBe(2);
    expect(current.entries).toBe("2");
  });

  test("REFUND não pode referenciar uma operação WIN", async () => {
    const wallet = await openWallet();
    const original = {
      ...bet(wallet),
      kind: Kind.Win,
    };

    await submit().execute(original);

    const result = await submit().execute({
      ...bet(wallet),
      kind: Kind.Refund,
      referenceExternalTransactionId:
        original.externalTransactionId,
    });

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(
      FailureCode.InvalidReferenceKind,
    );

    const current = await state(wallet.id);
    expect(current.balance).toBe("125.00");
    expect(current.ledger_balance).toBe("125.00");
    expect(current.version).toBe(2);
    expect(current.entries).toBe("2");
  });
    test("falha no ledger desfaz o débito e permite repetir a requisição", async () => {
    const wallet = await openWallet();
    const input = bet(wallet);
    const em = database().em.fork();

    // A falha será instalada apenas no banco temporário de teste.
    await em.execute(`
      CREATE FUNCTION simulate_wager_ledger_failure()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'simulated_ledger_failure';
      END;
      $$;
    `);

    try {
      // wallet.id é um UUID gerado internamente pela abertura.
      await em.execute(`
        CREATE TRIGGER simulate_wager_ledger_failure_trigger
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW
        WHEN (NEW.wallet_id = '${wallet.id}'::uuid)
        EXECUTE FUNCTION simulate_wager_ledger_failure();
      `);

      try {
        await expect(
          submit().execute(input),
        ).rejects.toThrow("simulated_ledger_failure");

        // O processador tentou atualizar a carteira antes do ledger.
        // Mesmo assim, a falha deve desfazer a operação inteira.
        expect(await state(wallet.id)).toEqual({
          balance: "100.00",
          version: 1,
          entries: "1",
          wagers: "0",
          ledger_balance: "100.00",
        });
      } finally {
        await em.execute(`
          DROP TRIGGER IF EXISTS
            simulate_wager_ledger_failure_trigger
          ON wallet_ledger_entries;
        `);
      }
    } finally {
      await em.execute(`
        DROP FUNCTION IF EXISTS simulate_wager_ledger_failure();
      `);
    }

    // A mesma chave pode ser tentada novamente porque nada foi confirmado.
    const retry = await submit().execute(input);

    expect(retry.status).toBe(Status.Processed);
    expect(retry.idempotentReplay).toBe(false);
    expect(retry.balance?.amount).toBe("75.00");

    expect(await state(wallet.id)).toEqual({
      balance: "75.00",
      version: 2,
      entries: "2",
      wagers: "1",
      ledger_balance: "75.00",
    });
  });
    test("banco rejeita alteração de saldo sem ledger", async () => {
    const wallet = await openWallet();

    await expect(
      database().em.fork().transactional(async (em) => {
        await em.execute(
          `UPDATE wallets SET balance = '999.00' WHERE id = ?`,
          [wallet.id],
        );
      }),
    ).rejects.toThrow("wallet_ledger_balance_mismatch");

    expect(await state(wallet.id)).toEqual({
      balance: "100.00",
      version: 1,
      entries: "1",
      wagers: "0",
      ledger_balance: "100.00",
    });
  });

  test("banco rejeita alteração de versão sem movimentação", async () => {
    const wallet = await openWallet();

    await expect(
      database().em.fork().transactional(async (em) => {
        await em.execute(
          `UPDATE wallets SET version = version + 1 WHERE id = ?`,
          [wallet.id],
        );
      }),
    ).rejects.toThrow("wallet_ledger_version_mismatch");

    const current = await state(wallet.id);

    expect(current.version).toBe(1);
    expect(current.balance).toBe("100.00");
    expect(current.ledger_balance).toBe("100.00");
  });
    test("aposta e replay geram apenas um evento na outbox", async () => {
    const wallet = await openWallet();
    const input = bet(wallet);

    const result = await submit().execute(input);
    await submit().execute(input);

    const events = await database().em.fork().find(
      OutboxEventRecord,
      { aggregateId: result.transactionId },
    );

    expect(events).toHaveLength(1);

    const event = events[0];

    if (!event) {
      throw new Error("Evento não encontrado.");
    }

    expect(event.eventType).toBe("transaction.processed");
    expect(event.publishedAt).toBeNull();
    expect(event.attempts).toBe(0);
    expect(event.payload).toMatchObject({
      eventId: event.id,
      transactionId: result.transactionId,
      walletId: wallet.id,
      status: "PROCESSED",
      money: {
        amount: "25.00",
        currency: "BRL",
      },
      balance: {
        amount: "75.00",
        currency: "BRL",
      },
    });
  });

  test("falha na outbox desfaz saldo ledger e transação", async () => {
    const wallet = await openWallet();
    const input = bet(wallet);
    const em = database().em.fork();

    // A abertura já terminou. A falha afetará apenas eventos
    // desta carteira inseridos durante o teste.
    await em.execute(`
      CREATE FUNCTION simulate_outbox_failure()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'simulated_outbox_failure';
      END;
      $$;
    `);

    try {
      await em.execute(`
        CREATE TRIGGER simulate_outbox_failure_trigger
        BEFORE INSERT ON outbox_events
        FOR EACH ROW
        WHEN (
          NEW.payload->>'walletId' = '${wallet.id}'
        )
        EXECUTE FUNCTION simulate_outbox_failure();
      `);

      try {
        await expect(
          submit().execute(input),
        ).rejects.toThrow("simulated_outbox_failure");

        expect(await state(wallet.id)).toEqual({
          balance: "100.00",
          version: 1,
          entries: "1",
          wagers: "0",
          ledger_balance: "100.00",
        });

        // Resta somente o evento da abertura da carteira.
        expect(
          await em.count(OutboxEventRecord, {}),
        ).toBeGreaterThanOrEqual(1);

        const rows = await em.execute<{ total: string }[]>(
          `SELECT count(*) AS total
           FROM outbox_events
           WHERE payload->>'walletId' = ?`,
          [wallet.id],
        );

        expect(rows[0]?.total).toBe("1");
      } finally {
        await em.execute(`
          DROP TRIGGER IF EXISTS simulate_outbox_failure_trigger
          ON outbox_events;
        `);
      }
    } finally {
      await em.execute(`
        DROP FUNCTION IF EXISTS simulate_outbox_failure();
      `);
    }

    const retry = await submit().execute(input);

    expect(retry.status).toBe(Status.Processed);
    expect(retry.idempotentReplay).toBe(false);
    expect(retry.balance?.amount).toBe("75.00");

    expect(
      await em.count(OutboxEventRecord, {
        aggregateId: retry.transactionId,
      }),
    ).toBe(1);

    expect(await state(wallet.id)).toEqual({
      balance: "75.00",
      version: 2,
      entries: "2",
      wagers: "1",
      ledger_balance: "75.00",
    });
  });
});


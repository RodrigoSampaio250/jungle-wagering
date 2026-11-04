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
});
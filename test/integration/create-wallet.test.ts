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
  WalletAlreadyExistsError,
  type WalletOpening,
} from "../../src/application/ports/wallet-opening-store";
import { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmWalletOpeningStore } from "../../src/infrastructure/database/mikro-orm-wallet-opening.store";

const databaseName =
  `wagering_test_${crypto.randomUUID().replaceAll("-", "")}`;

let admin: MikroORM | undefined;
let orm: MikroORM | undefined;
let databaseCreated = false;

function database(): MikroORM {
  if (orm === undefined) {
    throw new Error("Banco de teste não inicializado.");
  }

  return orm;
}

beforeAll(async () => {
  admin = await MikroORM.init(config);

  // Nome gerado internamente: somente letras, números e underscore.
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
    if (orm !== undefined) {
      await orm.close(true);
    }

    if (admin !== undefined && databaseCreated) {
      await admin.em.getConnection().execute(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    }
  } finally {
    if (admin !== undefined) {
      await admin.close(true);
    }
  }
}, 30_000);

function useCase(): CreateWallet {
  return new CreateWallet(
    new MikroOrmWalletOpeningStore(database()),
  );
}

async function counts(walletId: string): Promise<{
  wallets: string;
  transactions: string;
  entries: string;
}> {
  const rows = await database().em.fork().execute<
    {
      wallets: string;
      transactions: string;
      entries: string;
    }[]
  >(
    `SELECT
      (SELECT count(*) FROM wallets WHERE id = ?) AS wallets,
      (SELECT count(*) FROM wager_transactions
        WHERE wallet_id = ?) AS transactions,
      (SELECT count(*) FROM wallet_ledger_entries
        WHERE wallet_id = ?) AS entries`,
    [walletId, walletId, walletId],
  );

  const row = rows[0];

  if (row === undefined) {
    throw new Error("Consulta de contagem sem resultado.");
  }

  return row;
}

describe("CreateWallet — PostgreSQL real", () => {
  test("salva saldo, OPENING e ledger consistentes, com versão 1", async () => {
    const result = await useCase().execute({
      playerId: crypto.randomUUID(),
      initialBalance: {
        amount: "9007199254740993.01",
        currency: "BRL",
      },
    });

    expect(result.version).toBe(1);
    expect(result.balance.amount).toBe("9007199254740993.01");

    expect(await counts(result.id)).toEqual({
      wallets: "1",
      transactions: "1",
      entries: "1",
    });

    const rows = await database().em.fork().execute<
      {
        balance: string;
        calculated_balance: string;
        version: number;
        kind: string;
        status: string;
        result_balance: string;
      }[]
    >(
      `SELECT
        w.balance,
        w.version,
        t.kind,
        t.status,
        t.result_balance,
        (
          SELECT COALESCE(SUM(
            CASE WHEN direction = 'CREDIT'
              THEN amount ELSE -amount END
          ), 0)::numeric(20,2)
          FROM wallet_ledger_entries
          WHERE wallet_id = w.id
        ) AS calculated_balance
      FROM wallets w
      JOIN wager_transactions t ON t.wallet_id = w.id
      WHERE w.id = ?`,
      [result.id],
    );

    expect(rows[0]).toEqual({
      balance: "9007199254740993.01",
      calculated_balance: "9007199254740993.01",
      version: 1,
      kind: "OPENING",
      status: "PROCESSED",
      result_balance: "9007199254740993.01",
    });
  });

  test("saldo zero cria apenas a wallet", async () => {
    const result = await useCase().execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "0.00", currency: "BRL" },
    });

    expect(result.version).toBe(1);
    expect(await counts(result.id)).toEqual({
      wallets: "1",
      transactions: "0",
      entries: "0",
    });
  });

  test("aberturas concorrentes do mesmo jogador criam uma wallet", async () => {
    const playerId = crypto.randomUUID();

    const results = await Promise.allSettled([
      useCase().execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
      useCase().execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    ]);

    const successes = results.filter(
      (result) => result.status === "fulfilled",
    );
    const failures = results.filter(
      (result) => result.status === "rejected",
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const failure = failures[0];

    if (failure?.status !== "rejected") {
      throw new Error("Era esperado um conflito.");
    }

    expect(failure.reason).toBeInstanceOf(WalletAlreadyExistsError);

    const success = successes[0];

    if (success?.status !== "fulfilled") {
      throw new Error("Era esperada uma abertura válida.");
    }

    expect(await counts(success.value.id)).toEqual({
      wallets: "1",
      transactions: "1",
      entries: "1",
    });
  });

  test("falha no ledger desfaz wallet e transação já inseridas", async () => {
    let captured: WalletOpening | undefined;

    // Apenas captura os objetos montados pelo caso de uso.
    await new CreateWallet({
      async save(opening) {
        captured = opening;
      },
    }).execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const opening = captured;

    if (opening === undefined || opening.entry === undefined) {
      throw new Error("Abertura não foi capturada.");
    }

    const original = opening.entry;

    // Simula um defeito de persistência: referência inexistente.
    const invalidEntry = WalletLedgerEntry.rehydrate({
      id: original.id,
      walletId: original.walletId,
      transactionId: crypto.randomUUID(),
      direction: original.direction,
      money: original.money,
      balanceBefore: original.balanceBefore,
      balanceAfter: original.balanceAfter,
      createdAt: original.createdAt,
    });

    const store = new MikroOrmWalletOpeningStore(database());

    await expect(
      store.save({ ...opening, entry: invalidEntry }),
    ).rejects.toThrow("ledger_transaction_fk");

    expect(await counts(opening.wallet.id)).toEqual({
      wallets: "0",
      transactions: "0",
      entries: "0",
    });
  });
});
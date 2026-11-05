import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/create-wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmWalletOpeningStore } from "../../src/infrastructure/database/mikro-orm-wallet-opening.store";

const databaseName =
  `wagering_test_${crypto.randomUUID().replaceAll("-", "")}`;

const expectedTables = [
  "inbox_messages",
  "outbox_events",
  "wager_transactions",
  "wallet_ledger_entries",
  "wallets",
];

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

  // As migrations são executadas dentro do próprio teste.
}, 30_000);

afterAll(async () => {
  try {
    await orm?.close(true);
  } finally {
    try {
      if (admin !== undefined && databaseCreated) {
        await admin.em.getConnection().execute(
          `DROP DATABASE "${databaseName}" WITH (FORCE)`,
        );
      }
    } finally {
      await admin?.close(true);
    }
  }
}, 30_000);

async function applicationTables(): Promise<string[]> {
  const rows = await database().em.fork().execute<
    { table_name: string }[]
  >(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> 'mikro_orm_migrations'
     ORDER BY table_name`,
  );

  return rows.map((row) => row.table_name);
}

async function createWalletAndCheck(): Promise<void> {
  const wallet = await new CreateWallet(
    new MikroOrmWalletOpeningStore(database()),
  ).execute({
    playerId: crypto.randomUUID(),
    initialBalance: {
      amount: "100.00",
      currency: "BRL",
    },
  });

  expect(wallet.balance.amount).toBe("100.00");
  expect(wallet.version).toBe(1);

  const rows = await database().em.fork().execute<
    {
      balance: string;
      ledger_balance: string;
      entries: string;
      events: string;
    }[]
  >(
    `SELECT
      w.balance,
      (
        SELECT COALESCE(SUM(
          CASE WHEN direction = 'CREDIT'
            THEN amount ELSE -amount END
        ), 0)::numeric(20,2)
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS ledger_balance,
      (
        SELECT count(*)
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS entries,
      (
        SELECT count(*)
        FROM outbox_events
        WHERE payload->'data'->>'walletId' = w.id::text
      ) AS events
    FROM wallets w
    WHERE w.id = ?`,
    [wallet.id],
  );

  expect(rows[0]).toEqual({
    balance: "100.00",
    ledger_balance: "100.00",
    entries: "1",
    events: "2",
  });
}

describe("Migrations — PostgreSQL real", () => {
  test("aplica, reverte todas e reaplica com persistência funcional", async () => {
    const migrator = database().getMigrator();

    expect(await applicationTables()).toEqual([]);

    await migrator.up();

    expect(await applicationTables()).toEqual(expectedTables);

    const firstExecution = await migrator.getExecutedMigrations();

    expect(firstExecution).toHaveLength(5);

    await createWalletAndCheck();

    // Reverte somente o banco temporário deste teste.
    await migrator.down({ to: 0 });

    expect(await migrator.getExecutedMigrations())
      .toHaveLength(0);

    expect(await applicationTables()).toEqual([]);

    await migrator.up();

    expect(await applicationTables()).toEqual(expectedTables);

    const secondExecution = await migrator.getExecutedMigrations();

    expect(
      secondExecution.map((migration) => migration.name),
    ).toEqual(
      firstExecution.map((migration) => migration.name),
    );

    await createWalletAndCheck();
  }, 60_000);
});
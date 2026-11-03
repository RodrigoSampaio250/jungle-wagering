import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  MikroORM,
  type EntityManager,
} from "@mikro-orm/postgresql";
import config from "../../src/infrastructure/database/mikro-orm.config";

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterAll(async () => {
  if (orm) {
    await orm.close(true);
  }
});

async function withRollback(
  run: (em: EntityManager) => Promise<void>,
): Promise<void> {
  const em = orm.em.fork();

  await em.begin();

  try {
    await run(em);
  } finally {
    await em.rollback();
  }
}

async function insertWallet(
  em: EntityManager,
  playerId: string,
  balance: string,
): Promise<void> {
  await em.execute(
    `INSERT INTO wallets (
      id, player_id, currency, balance,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [crypto.randomUUID(), playerId, "BRL", balance, 1],
  );
}

describe("Wallet schema — PostgreSQL real", () => {
  test("o banco rejeita saldo negativo", async () => {
    await withRollback(async (em) => {
      await expect(
        insertWallet(em, crypto.randomUUID(), "-1.00"),
      ).rejects.toThrow("wallets_balance_nonnegative");
    });
  });

  test("o banco rejeita wallet duplicada por jogador e moeda", async () => {
    await withRollback(async (em) => {
      const playerId = crypto.randomUUID();

      await insertWallet(em, playerId, "0.00");

      await expect(
        insertWallet(em, playerId, "0.00"),
      ).rejects.toThrow("wallets_player_currency_unique");
    });
  });

  test("preserva valores monetários como strings exatas", async () => {
    await withRollback(async (em) => {
      const playerId = crypto.randomUUID();

      await insertWallet(em, playerId, "9007199254740993.01");

      const rows = await em.execute<{ balance: string }[]>(
        "SELECT balance FROM wallets WHERE player_id = ?",
        [playerId],
      );

      expect(rows).toHaveLength(1);
      expect(typeof rows[0]?.balance).toBe("string");
      expect(rows[0]?.balance).toBe("9007199254740993.01");
    });
  });
});
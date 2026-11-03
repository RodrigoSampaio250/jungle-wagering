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

async function withFixture(
  run: (
    em: EntityManager,
    ids: { walletId: string; transactionId: string; entryId: string },
  ) => Promise<void>,
): Promise<void> {
  const em = orm.em.fork();
  await em.begin();

  try {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const entryId = crypto.randomUUID();

    // Fixture de schema: todos os registros serão desfeitos.
    await em.execute(
      `INSERT INTO wallets (
        id, player_id, currency, balance, version, created_at, updated_at
      ) VALUES (?, ?, 'BRL', '75.00', 2, NOW(), NOW())`,
      [walletId, playerId],
    );

    await em.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key,
        payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, status, created_at
      ) VALUES (
        ?, 'provider-test', ?, ?, ?, ?, ?, 'round-test', 'game-test',
        'BET', '25.00', 'BRL', 'PENDING', NOW()
      )`,
      [
        transactionId,
        transactionId,
        transactionId,
        "a".repeat(64),
        walletId,
        playerId,
      ],
    );

    await em.execute(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount,
        currency, balance_before, balance_after, created_at
      ) VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '75.00', NOW())`,
      [entryId, walletId, transactionId],
    );

    await em.execute(
      `UPDATE wager_transactions
       SET status = 'PROCESSED',
           result_balance = '75.00',
           processed_at = NOW()
       WHERE id = ?`,
      [transactionId],
    );

    await run(em, { walletId, transactionId, entryId });
  } finally {
    await em.rollback();
  }
}

describe("Ledger schema — PostgreSQL real", () => {
  test("bloqueia alteração de lançamento", async () => {
    await withFixture(async (em, { entryId }) => {
      await expect(
        em.execute(
          "UPDATE wallet_ledger_entries SET created_at = NOW() WHERE id = ?",
          [entryId],
        ),
      ).rejects.toThrow("Ledger entries are immutable");
    });
  });

  test("bloqueia exclusão de lançamento", async () => {
    await withFixture(async (em, { entryId }) => {
      await expect(
        em.execute(
          "DELETE FROM wallet_ledger_entries WHERE id = ?",
          [entryId],
        ),
      ).rejects.toThrow("Ledger entries are immutable");
    });
  });

  test("bloqueia lançamento duplicado para a mesma operação", async () => {
    await withFixture(async (em, { walletId, transactionId }) => {
      await expect(
        em.execute(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, amount,
            currency, balance_before, balance_after, created_at
          ) VALUES (
            ?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '75.00', NOW()
          )`,
          [crypto.randomUUID(), walletId, transactionId],
        ),
      ).rejects.toThrow("ledger_wallet_transaction_unique");
    });
  });

  test("bloqueia lançamento com aritmética incorreta", async () => {
    await withFixture(async (em, { walletId, transactionId }) => {
      await expect(
        em.execute(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, amount,
            currency, balance_before, balance_after, created_at
          ) VALUES (
            ?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '90.00', NOW()
          )`,
          [crypto.randomUUID(), walletId, transactionId],
        ),
      ).rejects.toThrow("ledger_arithmetic_valid");
    });
  });

  test("bloqueia modificação de transação terminal", async () => {
    await withFixture(async (em, { transactionId }) => {
      await expect(
        em.execute(
          "UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?",
          [transactionId],
        ),
      ).rejects.toThrow("Terminal transactions are immutable");
    });
  });
});

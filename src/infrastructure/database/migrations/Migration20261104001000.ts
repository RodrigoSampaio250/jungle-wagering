import { Migration } from "@mikro-orm/migrations";

export class Migration20261104001000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION assert_wallet_ledger(p_wallet_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      DECLARE
        wallet_row wallets%ROWTYPE;
        calculated_balance numeric;
        entry_count bigint;
        opening_count bigint;
        expected_version bigint;
      BEGIN
        SELECT * INTO wallet_row
        FROM wallets
        WHERE id = p_wallet_id
        FOR UPDATE;

        IF NOT FOUND THEN
          RETURN;
        END IF;

        SELECT
          COALESCE(SUM(
            CASE WHEN e.direction = 'CREDIT'
              THEN e.amount ELSE -e.amount END
          ), 0),
          COUNT(*),
          COUNT(*) FILTER (WHERE t.kind = 'OPENING')
        INTO calculated_balance, entry_count, opening_count
        FROM wallet_ledger_entries e
        JOIN wager_transactions t ON t.id = e.transaction_id
        WHERE e.wallet_id = p_wallet_id;

        IF wallet_row.balance <> calculated_balance THEN
          RAISE EXCEPTION 'wallet_ledger_balance_mismatch'
            USING ERRCODE = '23514';
        END IF;

        IF opening_count > 1 THEN
          RAISE EXCEPTION 'wallet_multiple_openings'
            USING ERRCODE = '23514';
        END IF;

        -- A abertura começa na versão 1.
        -- Uma abertura com saldo positivo já possui um ledger.
        expected_version :=
          entry_count + CASE WHEN opening_count = 0 THEN 1 ELSE 0 END;

        IF wallet_row.version <> expected_version THEN
          RAISE EXCEPTION 'wallet_ledger_version_mismatch'
            USING ERRCODE = '23514';
        END IF;
      END;
      $$;
    `);

    this.addSql(`
      CREATE FUNCTION assert_transaction_ledger(p_transaction_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      DECLARE
        transaction_row wager_transactions%ROWTYPE;
        entry_count bigint;
        actual_direction text;
        expected_direction text;
        reference_kind text;
      BEGIN
        SELECT * INTO transaction_row
        FROM wager_transactions
        WHERE id = p_transaction_id;

        IF NOT FOUND THEN
          RETURN;
        END IF;

        SELECT COUNT(*), MIN(direction)
        INTO entry_count, actual_direction
        FROM wallet_ledger_entries
        WHERE transaction_id = p_transaction_id;

        IF transaction_row.status = 'PROCESSED'
          AND transaction_row.kind <> 'LOSS'
        THEN
          IF entry_count <> 1 THEN
            RAISE EXCEPTION 'processed_transaction_requires_one_ledger'
              USING ERRCODE = '23514';
          END IF;

          IF transaction_row.kind = 'ROLLBACK' THEN
            SELECT kind INTO reference_kind
            FROM wager_transactions
            WHERE id = transaction_row.reference_transaction_id;

            expected_direction := CASE
              WHEN reference_kind = 'BET' THEN 'CREDIT'
              WHEN reference_kind IN ('WIN', 'REFUND') THEN 'DEBIT'
              ELSE NULL
            END;
          ELSE
            expected_direction := CASE
              WHEN transaction_row.kind = 'BET' THEN 'DEBIT'
              WHEN transaction_row.kind IN ('OPENING', 'WIN', 'REFUND')
                THEN 'CREDIT'
              ELSE NULL
            END;
          END IF;

          IF expected_direction IS NULL
            OR actual_direction IS DISTINCT FROM expected_direction
          THEN
            RAISE EXCEPTION 'transaction_ledger_direction_mismatch'
              USING ERRCODE = '23514';
          END IF;
        ELSE
          IF entry_count <> 0 THEN
            RAISE EXCEPTION 'transaction_must_not_have_ledger'
              USING ERRCODE = '23514';
          END IF;
        END IF;
      END;
      $$;
    `);

    this.addSql(`
      CREATE FUNCTION enforce_financial_consistency()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          PERFORM assert_wallet_ledger(NEW.id);

        ELSIF TG_TABLE_NAME = 'wallet_ledger_entries' THEN
          PERFORM assert_wallet_ledger(NEW.wallet_id);
          PERFORM assert_transaction_ledger(NEW.transaction_id);

        ELSIF TG_TABLE_NAME = 'wager_transactions' THEN
          PERFORM assert_wallet_ledger(NEW.wallet_id);
          PERFORM assert_transaction_ledger(NEW.id);
        END IF;

        RETURN NULL;
      END;
      $$;
    `);

    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_financial_consistency
      AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_financial_consistency();
    `);

    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_financial_consistency
      AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_financial_consistency();
    `);

    this.addSql(`
      CREATE CONSTRAINT TRIGGER transactions_financial_consistency
      AFTER INSERT OR UPDATE ON wager_transactions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_financial_consistency();
    `);

    // Confere também os dados que já existiam antes da migration.
    this.addSql(`
      SELECT assert_wallet_ledger(id) FROM wallets;
    `);

    this.addSql(`
      SELECT assert_transaction_ledger(id)
      FROM wager_transactions;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS transactions_financial_consistency
      ON wager_transactions;
    `);

    this.addSql(`
      DROP TRIGGER IF EXISTS ledger_financial_consistency
      ON wallet_ledger_entries;
    `);

    this.addSql(`
      DROP TRIGGER IF EXISTS wallets_financial_consistency
      ON wallets;
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS enforce_financial_consistency();
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS assert_transaction_ledger(uuid);
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS assert_wallet_ledger(uuid);
    `);
  }
}
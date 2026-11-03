import { Migration } from '@mikro-orm/migrations';

export class Migration20261103230026 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(100) not null, "external_transaction_id" varchar(200) not null, "idempotency_key" varchar(300) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(200) not null, "game_id" varchar(200) not null, "kind" varchar(20) not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "status" varchar(30) not null, "reference_external_transaction_id" varchar(200) null, "reference_transaction_id" uuid null, "failure_code" varchar(100) null, "result_balance" numeric(20,2) null, "reference_attempts" int not null default 0, "next_reference_attempt_at" timestamptz null, "created_at" timestamptz not null, "processed_at" timestamptz null, constraint "wager_transactions_pkey" primary key ("id"), constraint wager_transactions_amount_valid check (amount >= 0 AND (kind = 'LOSS' OR amount > 0)), constraint wager_transactions_kind_valid check (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')), constraint wager_transactions_status_valid check (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')), constraint wager_transactions_currency_valid check (currency IN ('BRL', 'USD')), constraint wager_transactions_reference_required check (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL), constraint wager_transactions_attempts_valid check (reference_attempts >= 0), constraint wager_transactions_result_balance_valid check (result_balance IS NULL OR result_balance >= 0));`);
    this.addSql(`create index "wager_transactions_reference_retry_idx" on "wager_transactions" ("status", "next_reference_attempt_at");`);
    this.addSql(`create index "wager_transactions_wallet_idx" on "wager_transactions" ("wallet_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_unique" unique ("idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(6) not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null, constraint "wallet_ledger_entries_pkey" primary key ("id"), constraint ledger_amount_positive check (amount > 0), constraint ledger_balances_nonnegative check (balance_before >= 0 AND balance_after >= 0), constraint ledger_currency_valid check (currency IN ('BRL', 'USD')), constraint ledger_arithmetic_valid check (
          (direction = 'DEBIT'
            AND balance_after = balance_before - amount)
          OR
          (direction = 'CREDIT'
            AND balance_after = balance_before + amount)
        ));`);
    this.addSql(`create index "ledger_wallet_cursor_idx" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`);

    // A referência interna precisa apontar para uma transação existente.
    this.addSql(`
      alter table wager_transactions
      add constraint wager_reference_fk
      foreign key (reference_transaction_id)
      references wager_transactions (id)
      on delete restrict;
    `);

    // Permite vincular o lançamento à transação e aos seus dados financeiros.
    this.addSql(`
      alter table wager_transactions
      add constraint wager_ledger_target_unique
      unique (id, wallet_id, currency, amount);
    `);

    this.addSql(`
      alter table wallets
      add constraint wallets_id_currency_unique
      unique (id, currency);
    `);

    this.addSql(`
      alter table wallet_ledger_entries
      add constraint ledger_wallet_currency_fk
      foreign key (wallet_id, currency)
      references wallets (id, currency)
      on delete restrict;
    `);

    this.addSql(`
      alter table wallet_ledger_entries
      add constraint ledger_transaction_fk
      foreign key (transaction_id, wallet_id, currency, amount)
      references wager_transactions (id, wallet_id, currency, amount)
      on delete restrict;
    `);

    // Apenas uma reversão processada de cada tipo para cada referência.
    this.addSql(`
      create unique index wager_processed_reversal_unique
      on wager_transactions (reference_transaction_id, kind)
      where status = 'PROCESSED'
        and kind in ('REFUND', 'ROLLBACK');
    `);

    // Ledger imutável: bloqueia UPDATE, DELETE e TRUNCATE.
    this.addSql(`
      create function prevent_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'Ledger entries are immutable'
          using errcode = '23514';
      end;
      $$;
    `);

    this.addSql(`
      create trigger ledger_no_update_delete
      before update or delete on wallet_ledger_entries
      for each row execute function prevent_ledger_mutation();
    `);

    this.addSql(`
      create trigger ledger_no_truncate
      before truncate on wallet_ledger_entries
      for each statement execute function prevent_ledger_mutation();
    `);

    // Transações terminais não podem ser modificadas nem excluídas.
    this.addSql(`
      create function prevent_terminal_transaction_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        if OLD.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'Terminal transactions are immutable'
            using errcode = '23514';
        end if;

        if TG_OP = 'DELETE' then
          return OLD;
        end if;

        return NEW;
      end;
      $$;
    `);

    this.addSql(`
      create trigger wager_terminal_immutable
      before update or delete on wager_transactions
      for each row
      execute function prevent_terminal_transaction_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);

    this.addSql(`
      alter table wallets
      drop constraint if exists wallets_id_currency_unique;
    `);

    this.addSql(`drop function if exists prevent_ledger_mutation();`);

    this.addSql(`
      drop function if exists prevent_terminal_transaction_mutation();
    `);
  }

}

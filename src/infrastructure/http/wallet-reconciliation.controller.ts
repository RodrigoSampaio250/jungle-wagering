import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";

interface ReconciliationRow {
  id: string;
  currency: string;
  balance: string;
  ledger_balance: string;
  difference: string;
  consistent: boolean;
  entry_count: string;
}

@Controller("wallets")
export class WalletReconciliationController {
  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {}

  @Post(":id/reconciliation")
  @HttpCode(200)
  async reconcile(
    @Param("id", new ParseUUIDPipe()) walletId: string,
  ) {
    const row = await this.calculate(walletId);
    const checkedEntries = Number(row.entry_count);

    if (!Number.isSafeInteger(checkedEntries)) {
      throw new Error(
        "Quantidade de lançamentos fora do intervalo suportado.",
      );
    }

    return {
      walletId: row.id,
      storedBalance: {
        amount: row.balance,
        currency: row.currency,
      },
      calculatedBalance: {
        amount: row.ledger_balance,
        currency: row.currency,
      },
      difference: {
        amount: row.difference,
        currency: row.currency,
      },
      consistent: row.consistent,
      checkedEntries,
    };
  }

  @Get(":id/reconciliation")
  async reconcileLegacy(
    @Param("id", new ParseUUIDPipe()) walletId: string,
  ) {
    const row = await this.calculate(walletId);

    return {
      walletId: row.id,
      currency: row.currency,
      storedBalance: row.balance,
      ledgerBalance: row.ledger_balance,
      difference: row.difference,
      consistent: row.consistent,
      entryCount: row.entry_count,
    };
  }

  private async calculate(
    walletId: string,
  ): Promise<ReconciliationRow> {
    const rows = await this.orm.em.fork().execute<
      ReconciliationRow[]
    >(
      `SELECT
        w.id,
        w.currency,
        w.balance,
        totals.ledger_balance::numeric(20,2) AS ledger_balance,
        (w.balance - totals.ledger_balance)::numeric(21,2)
          AS difference,
        w.balance = totals.ledger_balance AS consistent,
        totals.entry_count
      FROM wallets w
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(SUM(
            CASE WHEN direction = 'CREDIT'
              THEN amount ELSE -amount END
          ), 0) AS ledger_balance,
          COUNT(*) AS entry_count
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) totals
      WHERE w.id = ?`,
      [walletId],
    );

    const row = rows[0];

    if (!row) {
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Carteira não encontrada.",
      });
    }

    if (!row.consistent) {
      console.error(
        JSON.stringify({
          event: "wallet.reconciliation.mismatch",
          walletId: row.id,
        }),
      );
    }

    return row;
  }
}
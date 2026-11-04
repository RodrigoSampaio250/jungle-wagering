import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { isUUID } from "class-validator";
import { WalletRecord } from "../database/wallet.record";
import { WalletLedgerEntryRecord } from "../database/wallet-ledger-entry.record";

interface LedgerRow {
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

@Controller("wallets")
export class WalletLedgerController {
  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {}

  @Get(":id/ledger")
  async list(
    @Param("id", new ParseUUIDPipe()) walletId: string,
    @Query("limit") rawLimit: unknown,
    @Query("cursor") cursor: unknown,
  ) {
    const limitText = rawLimit === undefined ? "20" : rawLimit;

    if (
      typeof limitText !== "string" ||
      !/^[1-9][0-9]{0,2}$/.test(limitText) ||
      Number(limitText) > 100
    ) {
      throw new BadRequestException({
        code: "INVALID_LIMIT",
        message: "limit deve ser um inteiro entre 1 e 100.",
      });
    }

    if (
      cursor !== undefined &&
      (typeof cursor !== "string" || !isUUID(cursor))
    ) {
      throw new BadRequestException({
        code: "INVALID_CURSOR",
        message: "cursor deve ser o UUID de um lançamento.",
      });
    }

    const limit = Number(limitText);
    const em = this.orm.em.fork();

    const wallet = await em.findOne(WalletRecord, {
      id: walletId,
    });

    if (!wallet) {
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Carteira não encontrada.",
      });
    }

    if (typeof cursor === "string") {
      const entry = await em.findOne(WalletLedgerEntryRecord, {
        id: cursor,
        walletId,
      });

      if (!entry) {
        throw new BadRequestException({
          code: "INVALID_CURSOR",
          message: "O cursor não pertence ao extrato desta carteira.",
        });
      }
    }

    const hasCursor = typeof cursor === "string";

    const cursorCondition = hasCursor
      ? `AND (e.created_at, e.id) > (
          SELECT c.created_at, c.id
          FROM wallet_ledger_entries c
          WHERE c.id = ? AND c.wallet_id = ?
        )`
      : "";

    const parameters = hasCursor
      ? [walletId, cursor, walletId, limit + 1]
      : [walletId, limit + 1];

    // A comparação fica no PostgreSQL para preservar
    // a precisão dos timestamps usados no cursor.
    const rows = await em.execute<LedgerRow[]>(
      `SELECT
        e.id,
        e.transaction_id,
        e.direction,
        e.amount,
        e.currency,
        e.balance_before,
        e.balance_after,
        e.created_at
      FROM wallet_ledger_entries e
      WHERE e.wallet_id = ?
      ${cursorCondition}
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT ?`,
      parameters,
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      walletId,
      items: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transaction_id,
        direction: entry.direction,
        money: {
          amount: entry.amount,
          currency: entry.currency,
        },
        balanceBefore: entry.balance_before,
        balanceAfter: entry.balance_after,
        createdAt: entry.created_at,
      })),
      nextCursor: hasMore && last ? last.id : null,
    };
  }
}
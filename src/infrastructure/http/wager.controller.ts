import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { SubmitWager } from "../../application/submit-wager";
import { WagerTransactionRecord } from "../database/wager-transaction.record";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../../application/ports/wager-processor";
import { InvalidMoneyError } from "../../domain/money";
import { InvalidWagerTransactionError } from "../../domain/wager-transaction.types";
import { MikroOrmWagerProcessor } from "../database/mikro-orm-wager-processor";
import { SubmitWagerDto } from "./dto/submit-wager.dto";

@Controller("transactions")
export class WagerController {
  private readonly submitWager: SubmitWager;

  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {
    this.submitWager = new SubmitWager(
      new MikroOrmWagerProcessor(orm),
    );
  }

     @Get(":id")
  async findById(
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const transaction = await this.orm.em.fork().findOne(
      WagerTransactionRecord,
      { id },
    );

    if (!transaction) {
      throw new NotFoundException({
        code: "TRANSACTION_NOT_FOUND",
        message: "Transação não encontrada.",
      });
    }

    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      status: transaction.status,
      balance:
        transaction.resultBalance === null
          ? null
          : {
              amount: transaction.resultBalance,
              currency: transaction.currency,
            },
      failureCode: transaction.failureCode,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }

  @Post()
  @HttpCode(200)
  async submit(
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: SubmitWagerDto,
  ) {
    if (
      typeof idempotencyKey !== "string" ||
      !idempotencyKey.trim() ||
      idempotencyKey.length > 300
    ) {
      throw new BadRequestException({
        code: "INVALID_IDEMPOTENCY_KEY",
        message:
          "O header Idempotency-Key é obrigatório e deve ter até 300 caracteres.",
      });
    }

    try {
      return await this.submitWager.execute({
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        idempotencyKey,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId,
        gameId: body.gameId,
        kind: body.kind,
        money: body.money,
        ...(body.referenceExternalTransactionId !== undefined
          ? {
              referenceExternalTransactionId:
                body.referenceExternalTransactionId,
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({
          code: "IDEMPOTENCY_CONFLICT",
          message: error.message,
        });
      }

      if (error instanceof ExternalTransactionConflictError) {
        throw new ConflictException({
          code: "EXTERNAL_TRANSACTION_CONFLICT",
          message: error.message,
        });
      }

      if (
        error instanceof InvalidMoneyError ||
        error instanceof InvalidWagerTransactionError
      ) {
        throw new BadRequestException({
          code: "INVALID_TRANSACTION",
          message: error.message,
        });
      }

      throw error;
    }
  }
}
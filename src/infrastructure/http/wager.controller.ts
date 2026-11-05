import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { SubmitWager } from "../../application/submit-wager";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../../application/ports/wager-processor";
import { InvalidMoneyError } from "../../domain/money";
import {
  InvalidWagerTransactionError,
  WagerTransactionStatus as Status,
} from "../../domain/wager-transaction.types";
import { MikroOrmWagerProcessor } from "../database/mikro-orm-wager-processor";
import { WagerTransactionRecord } from "../database/wager-transaction.record";
import { SubmitWagerDto } from "./dto/submit-wager.dto";

interface HttpResponse {
  status(code: number): unknown;
}

const transientCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "40001",
  "40P01",
  "53300",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
]);

function isTransientInfrastructureError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }

    const details = current as Record<string, unknown>;

    if (
      typeof details.code === "string" &&
      transientCodes.has(details.code)
    ) {
      return true;
    }

    current = details.cause;
  }

  return false;
}

@Controller()
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

  @Get([
    "transactions/lookup/external",
    "wagering/transactions/lookup/external",
  ])
  async findByExternalId(
    @Query("providerId") providerId: unknown,
    @Query("externalTransactionId") externalTransactionId: unknown,
  ) {
    return this.lookupExternal(
      providerId,
      externalTransactionId,
    );
  }

  @Get(
    "providers/:providerId/wagering/transactions/:externalTransactionId",
  )
  async findByProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.lookupExternal(
      providerId,
      externalTransactionId,
    );
  }

  @Get([
    "transactions/:id",
    "wagering/transactions/:id",
  ])
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

    return this.serialize(transaction);
  }

  @Post([
    "transactions",
    "wagering/transactions",
  ])
  @HttpCode(HttpStatus.OK)
  async submit(
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: SubmitWagerDto,
    @Res({ passthrough: true }) response: HttpResponse,
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
      const result = await this.submitWager.execute({
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

      switch (result.status) {
        case Status.Pending:
        case Status.PendingReference:
          response.status(HttpStatus.ACCEPTED);
          break;

        case Status.Rejected:
          response.status(HttpStatus.UNPROCESSABLE_ENTITY);
          break;

        case Status.Failed:
          response.status(HttpStatus.INTERNAL_SERVER_ERROR);
          break;

        case Status.Processed:
          response.status(HttpStatus.OK);
          break;
      }

      return result;
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

      if (isTransientInfrastructureError(error)) {
        throw new ServiceUnavailableException({
          code: "INFRASTRUCTURE_UNAVAILABLE",
          message:
            "Serviço temporariamente indisponível. Reenvie usando a mesma Idempotency-Key.",
        });
      }

      throw error;
    }
  }

  private async lookupExternal(
    providerId: unknown,
    externalTransactionId: unknown,
  ) {
    if (
      typeof providerId !== "string" ||
      !providerId.trim() ||
      providerId.length > 100 ||
      typeof externalTransactionId !== "string" ||
      !externalTransactionId.trim() ||
      externalTransactionId.length > 200
    ) {
      throw new BadRequestException({
        code: "INVALID_TRANSACTION_LOOKUP",
        message:
          "Informe providerId e externalTransactionId válidos.",
      });
    }

    const transaction = await this.orm.em.fork().findOne(
      WagerTransactionRecord,
      {
        providerId,
        externalTransactionId,
      },
    );

    if (!transaction) {
      throw new NotFoundException({
        code: "TRANSACTION_NOT_FOUND",
        message: "Transação não encontrada.",
      });
    }

    return this.serialize(transaction);
  }

  private serialize(transaction: WagerTransactionRecord) {
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
}
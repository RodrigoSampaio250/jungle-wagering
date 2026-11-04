import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../application/create-wallet";
import { WalletAlreadyExistsError } from "../../application/ports/wallet-opening-store";
import { InvalidMoneyError } from "../../domain/money";
import { InvalidWalletError } from "../../domain/wallet";
import { MikroOrmWalletOpeningStore } from "../database/mikro-orm-wallet-opening.store";
import { WalletRecord } from "../database/wallet.record";
import { CreateWalletDto } from "./dto/create-wallet.dto";

@Controller("wallets")
export class WalletController {
  private readonly createWallet: CreateWallet;

  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {
    this.createWallet = new CreateWallet(
      new MikroOrmWalletOpeningStore(orm),
    );
  }

  @Post()
  async create(
    @Body() body: CreateWalletDto,
  ) {
    try {
      return await this.createWallet.execute({
        playerId: body.playerId,
        initialBalance: body.initialBalance,
      });
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({
          code: "WALLET_ALREADY_EXISTS",
          message: error.message,
        });
      }

      if (
        error instanceof InvalidMoneyError ||
        error instanceof InvalidWalletError
      ) {
        throw new BadRequestException({
          code: "INVALID_WALLET",
          message: error.message,
        });
      }

      throw error;
    }
  }

  @Get(":id")
  async findById(
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const wallet = await this.orm.em.fork().findOne(
      WalletRecord,
      { id },
    );

    if (!wallet) {
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Carteira não encontrada.",
      });
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
    };
  }
}
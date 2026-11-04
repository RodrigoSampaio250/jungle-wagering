import { Type } from "class-transformer";
import {
  IsDefined,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { WagerTransactionKind } from "../../../domain/wager-transaction.types";
import { MoneyDto } from "./create-wallet.dto";

export class SubmitWagerDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  roundId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  gameId!: string;

  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ValidateIf(
    (body: SubmitWagerDto) =>
      body.kind === WagerTransactionKind.Refund ||
      body.kind === WagerTransactionKind.Rollback ||
      body.referenceExternalTransactionId !== undefined,
  )
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  referenceExternalTransactionId?: string;
}

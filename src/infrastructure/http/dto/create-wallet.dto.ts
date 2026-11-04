import { Type } from "class-transformer";
import {
  IsDefined,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from "class-validator";

export class MoneyDto {
  @IsString()
  @Matches(/^[0-9]{1,18}\.[0-9]{2}$/, {
    message:
      "amount deve ser uma string com duas casas decimais, como 100.00",
  })
  amount!: string;

  @IsString()
  @IsIn(["BRL", "USD"])
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

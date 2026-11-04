import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { WalletController } from "./infrastructure/http/wallet.controller";
import { WagerController } from "./infrastructure/http/wager.controller";
import { WalletLedgerController } from "./infrastructure/http/wallet-ledger.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
    WalletController,
    WagerController,
    WalletLedgerController,
  ],
})
export class AppModule {}
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HealthController } from "./health.controller";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { MetricsController } from "./infrastructure/http/metrics.controller";
import { ProviderAuthGuard } from "./infrastructure/http/provider-auth.guard";
import { WalletController } from "./infrastructure/http/wallet.controller";
import { WagerController } from "./infrastructure/http/wager.controller";
import { WalletLedgerController } from "./infrastructure/http/wallet-ledger.controller";
import { WalletReconciliationController } from "./infrastructure/http/wallet-reconciliation.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
    MetricsController,
    WalletController,
    WagerController,
    WalletLedgerController,
    WalletReconciliationController,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ProviderAuthGuard,
    },
  ],
})
export class AppModule {}
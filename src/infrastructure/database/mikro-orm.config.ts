import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { WalletRecordSchema } from "./wallet.record";
import { WagerTransactionRecordSchema } from "./wager-transaction.record";
import { WalletLedgerEntryRecordSchema } from "./wallet-ledger-entry.record";
import { OutboxEventRecordSchema } from "./outbox-event.record";

export default defineConfig({
  entities: [
    WalletRecordSchema,
    WagerTransactionRecordSchema,
    WalletLedgerEntryRecordSchema,
    OutboxEventRecordSchema,
  ],
  clientUrl:
    process.env.DATABASE_URL ??
    "postgresql://wagering:wagering_local@127.0.0.1:5432/wagering",
  extensions: [Migrator],
  migrations: {
    path: "src/infrastructure/database/migrations",
    pathTs: "src/infrastructure/database/migrations",
    transactional: true,
    allOrNothing: true,
  },
  debug: false,
});
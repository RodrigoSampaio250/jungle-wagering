import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { HealthController } from "../../src/health.controller";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { configureHttp } from "../../src/infrastructure/http/configure-http";
import { WalletController } from "../../src/infrastructure/http/wallet.controller";
import { WagerController } from "../../src/infrastructure/http/wager.controller";
import { WalletLedgerController } from "../../src/infrastructure/http/wallet-ledger.controller";
import { WalletReconciliationController } from "../../src/infrastructure/http/wallet-reconciliation.controller";

@Module({})
class HttpTestModule {}

const databaseName =
  `wagering_test_${crypto.randomUUID().replaceAll("-", "")}`;

let admin: MikroORM | undefined;
let orm: MikroORM | undefined;
let app: INestApplication | undefined;
let databaseCreated = false;
let baseUrl = "";

beforeAll(async () => {
  admin = await MikroORM.init(config);

  await admin.em.getConnection().execute(
    `CREATE DATABASE "${databaseName}"`,
  );
  databaseCreated = true;

  const url = new URL(config.clientUrl!);
  url.pathname = `/${databaseName}`;

  orm = await MikroORM.init({
    ...config,
    clientUrl: url.toString(),
  });

  await orm.getMigrator().up();

  app = await NestFactory.create(
    {
      module: HttpTestModule,
      controllers: [
        HealthController,
        WalletController,
        WagerController,
        WalletLedgerController,
        WalletReconciliationController,
      ],
      providers: [
        {
          provide: MikroORM,
          useValue: orm,
        },
      ],
    },
    { logger: false },
  );

  configureHttp(app);

  // Porta zero pede uma porta disponível ao sistema operacional.
  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
}, 30_000);

afterAll(async () => {
  try {
    if (app) {
      await app.close();
    }
  } finally {
    try {
      if (orm) {
        await orm.close(true);
      }
    } finally {
      try {
        if (admin && databaseCreated) {
          await admin.em.getConnection().execute(
            `DROP DATABASE "${databaseName}" WITH (FORCE)`,
          );
        }
      } finally {
        if (admin) {
          await admin.close(true);
        }
      }
    }
  }
}, 30_000);

function post(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey !== undefined
        ? { "Idempotency-Key": idempotencyKey }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("API HTTP — PostgreSQL real", () => {
  test("cria carteira, processa aposta e consulta os resultados", async () => {
    const playerId = crypto.randomUUID();

    const created = await post("/wallets", {
      playerId,
      initialBalance: {
        amount: "100.00",
        currency: "BRL",
      },
    });

    expect(created.status).toBe(201);

    const wallet = await created.json() as {
      id: string;
      balance: { amount: string; currency: string };
      version: number;
    };

    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);

    const input = {
      providerId: "provider-http",
      externalTransactionId: crypto.randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: "round-http",
      gameId: "game-http",
      kind: "BET",
      money: {
        amount: "25.00",
        currency: "BRL",
      },
    };

    const key = crypto.randomUUID();

    const processed = await post("/transactions", input, key);
    expect(processed.status).toBe(200);

    const transaction = await processed.json() as {
      transactionId: string;
      status: string;
      balance: { amount: string; currency: string };
      idempotentReplay: boolean;
    };

    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.balance.amount).toBe("75.00");
    expect(transaction.idempotentReplay).toBe(false);

    const repeated = await post("/transactions", input, key);
    expect(repeated.status).toBe(200);

    expect(await repeated.json()).toEqual({
      ...transaction,
      idempotentReplay: true,
    });

    const lookup = await fetch(
      `${baseUrl}/transactions/${transaction.transactionId}`,
    );

    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      transactionId: transaction.transactionId,
      status: "PROCESSED",
      balance: {
        amount: "75.00",
        currency: "BRL",
      },
    });

    const externalQuery = new URLSearchParams({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    });

    const external = await fetch(
      `${baseUrl}/transactions/lookup/external?${externalQuery}`,
    );

    expect(external.status).toBe(200);
    expect(await external.json()).toMatchObject({
      transactionId: transaction.transactionId,
    });

    const current = await fetch(
      `${baseUrl}/wallets/${wallet.id}`,
    );

    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      balance: { amount: "75.00", currency: "BRL" },
      version: 2,
    });

    const firstPage = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1`,
    );

    expect(firstPage.status).toBe(200);

    const first = await firstPage.json() as {
      items: { direction: string }[];
      nextCursor: string | null;
    };

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.direction).toBe("CREDIT");

    if (typeof first.nextCursor !== "string") {
      throw new Error("Era esperado um cursor para a segunda página.");
    }

    const secondPage = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${first.nextCursor}`,
    );

    expect(secondPage.status).toBe(200);
    expect(await secondPage.json()).toMatchObject({
      items: [
        {
          direction: "DEBIT",
          money: { amount: "25.00", currency: "BRL" },
          balanceBefore: "100.00",
          balanceAfter: "75.00",
        },
      ],
      nextCursor: null,
    });

    const reconciliation = await fetch(
      `${baseUrl}/wallets/${wallet.id}/reconciliation`,
    );

    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      storedBalance: "75.00",
      ledgerBalance: "75.00",
      difference: "0.00",
      consistent: true,
      entryCount: "2",
    });
  });

  test("rejeita dinheiro numérico e não cria a carteira", async () => {
    const playerId = crypto.randomUUID();

    const invalid = await post("/wallets", {
      playerId,
      initialBalance: {
        amount: 100,
        currency: "BRL",
      },
    });

    expect(invalid.status).toBe(400);

    // A tentativa inválida não deve reservar jogador e moeda.
    const valid = await post("/wallets", {
      playerId,
      initialBalance: {
        amount: "100.00",
        currency: "BRL",
      },
    });

    expect(valid.status).toBe(201);
  });

  test("retorna 404 para uma transação inexistente", async () => {
    const response = await fetch(
      `${baseUrl}/transactions/${crypto.randomUUID()}`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
    });
  });

  test("readiness verifica o banco", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      database: "up",
    });
  });
});
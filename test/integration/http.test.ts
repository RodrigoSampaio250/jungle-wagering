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

interface WalletResponse {
  id: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

interface TransactionResponse {
  transactionId: string;
  status: string;
  balance: {
    amount: string;
    currency: string;
  } | null;
  failureCode: string | null;
  idempotentReplay: boolean;
}

interface LedgerPage {
  items: {
    direction: string;
  }[];
  nextCursor: string | null;
}

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

  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
}, 30_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      await orm?.close(true);
    } finally {
      try {
        if (admin && databaseCreated) {
          await admin.em.getConnection().execute(
            `DROP DATABASE "${databaseName}" WITH (FORCE)`,
          );
        }
      } finally {
        await admin?.close(true);
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

async function createFixture() {
  const playerId = crypto.randomUUID();

  const created = await post("/wallets", {
    playerId,
    initialBalance: {
      amount: "100.00",
      currency: "BRL",
    },
  });

  expect(created.status).toBe(201);

  const wallet = await created.json() as WalletResponse;

  const input = {
    providerId: "provider-http",
    externalTransactionId: crypto.randomUUID(),
    playerId,
    walletId: wallet.id,
    roundId: crypto.randomUUID(),
    gameId: "game-http",
    kind: "BET",
    money: {
      amount: "25.00",
      currency: "BRL",
    },
  };

  return { wallet, input };
}

async function expectReconciliation(
  walletId: string,
  amount: string,
  checkedEntries: number,
) {
  const response = await post(
    `/wallets/${walletId}/reconciliation`,
    {},
  );

  expect(response.status).toBe(200);

  expect(await response.json()).toEqual({
    walletId,
    storedBalance: {
      amount,
      currency: "BRL",
    },
    calculatedBalance: {
      amount,
      currency: "BRL",
    },
    difference: {
      amount: "0.00",
      currency: "BRL",
    },
    consistent: true,
    checkedEntries,
  });
}

describe("API HTTP — PostgreSQL real", () => {
  test("cria carteira, processa aposta e mantém as rotas anteriores", async () => {
    const { wallet, input } = await createFixture();

    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);

    const key = crypto.randomUUID();

    const processed = await post("/transactions", input, key);
    expect(processed.status).toBe(200);

    const transaction =
      await processed.json() as TransactionResponse;

    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.balance?.amount).toBe("75.00");
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
      balance: {
        amount: "75.00",
        currency: "BRL",
      },
      version: 2,
    });

    const firstPage = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1`,
    );

    expect(firstPage.status).toBe(200);

    const first = await firstPage.json() as LedgerPage;

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.direction).toBe("CREDIT");

    if (typeof first.nextCursor !== "string") {
      throw new Error(
        "Era esperado um cursor para a segunda página.",
      );
    }

    const secondPage = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${first.nextCursor}`,
    );

    expect(secondPage.status).toBe(200);
    expect(await secondPage.json()).toMatchObject({
      items: [
        {
          direction: "DEBIT",
          money: {
            amount: "25.00",
            currency: "BRL",
          },
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

  test("usa as rotas do enunciado e o contrato POST de reconciliação", async () => {
    const { wallet, input } = await createFixture();
    const key = crypto.randomUUID();

    const processed = await post(
      "/wagering/transactions",
      input,
      key,
    );

    expect(processed.status).toBe(200);

    const transaction =
      await processed.json() as TransactionResponse;

    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.balance?.amount).toBe("75.00");

    const repeated = await post(
      "/wagering/transactions",
      input,
      key,
    );

    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({
      ...transaction,
      idempotentReplay: true,
    });

    const lookup = await fetch(
      `${baseUrl}/wagering/transactions/${transaction.transactionId}`,
    );

    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      transactionId: transaction.transactionId,
      status: "PROCESSED",
    });

    const provider = encodeURIComponent(input.providerId);
    const externalId = encodeURIComponent(
      input.externalTransactionId,
    );

    const external = await fetch(
      `${baseUrl}/providers/${provider}/wagering/transactions/${externalId}`,
    );

    expect(external.status).toBe(200);
    expect(await external.json()).toMatchObject({
      transactionId: transaction.transactionId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    });

    const conflicting = await post(
      "/wagering/transactions",
      {
        ...input,
        money: {
          amount: "30.00",
          currency: "BRL",
        },
      },
      key,
    );

    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });

    await expectReconciliation(wallet.id, "75.00", 2);
  });

  test("rejeição de negócio retorna 422 e replay não movimenta saldo", async () => {
    const { wallet, input } = await createFixture();
    const key = crypto.randomUUID();

    const insufficient = {
      ...input,
      money: {
        amount: "150.00",
        currency: "BRL",
      },
    };

    const rejected = await post(
      "/wagering/transactions",
      insufficient,
      key,
    );

    expect(rejected.status).toBe(422);

    const transaction =
      await rejected.json() as TransactionResponse;

    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe(
      "INSUFFICIENT_BALANCE",
    );
    expect(transaction.balance?.amount).toBe("100.00");
    expect(transaction.idempotentReplay).toBe(false);

    const repeated = await post(
      "/wagering/transactions",
      insufficient,
      key,
    );

    expect(repeated.status).toBe(422);
    expect(await repeated.json()).toEqual({
      ...transaction,
      idempotentReplay: true,
    });

    const current = await fetch(
      `${baseUrl}/wallets/${wallet.id}`,
    );

    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      balance: {
        amount: "100.00",
        currency: "BRL",
      },
      version: 1,
    });

    await expectReconciliation(wallet.id, "100.00", 1);
  });

  test("referência ausente retorna 202 e preserva a operação pendente", async () => {
    const { wallet, input } = await createFixture();
    const key = crypto.randomUUID();

    const refund = {
      ...input,
      kind: "REFUND",
      referenceExternalTransactionId: crypto.randomUUID(),
    };

    const pending = await post(
      "/wagering/transactions",
      refund,
      key,
    );

    expect(pending.status).toBe(202);

    const transaction =
      await pending.json() as TransactionResponse;

    expect(transaction.status).toBe("PENDING_REFERENCE");
    expect(transaction.failureCode).toBeNull();
    expect(transaction.balance?.amount).toBe("100.00");
    expect(transaction.idempotentReplay).toBe(false);

    const repeated = await post(
      "/wagering/transactions",
      refund,
      key,
    );

    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toEqual({
      ...transaction,
      idempotentReplay: true,
    });

    const lookup = await fetch(
      `${baseUrl}/wagering/transactions/${transaction.transactionId}`,
    );

    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      status: "PENDING_REFERENCE",
      referenceExternalTransactionId:
        refund.referenceExternalTransactionId,
    });

    await expectReconciliation(wallet.id, "100.00", 1);
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
      `${baseUrl}/wagering/transactions/${crypto.randomUUID()}`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
    });
  });

  test("readiness verifica o banco", async () => {
    const response = await fetch(
      `${baseUrl}/health/ready`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      database: "up",
    });
  });
});
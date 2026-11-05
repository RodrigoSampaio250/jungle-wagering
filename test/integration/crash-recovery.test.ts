import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { resolve } from "node:path";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/create-wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmWalletOpeningStore } from "../../src/infrastructure/database/mikro-orm-wallet-opening.store";

const databaseName =
  `wagering_test_${crypto.randomUUID().replaceAll("-", "")}`;

const fixturePath = resolve(
  import.meta.dir,
  "../fixtures/crash-consumer.ts",
);

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
  maxAttempts: 1,
  requestHandler: {
    connectionTimeout: 3_000,
    requestTimeout: 10_000,
  },
});

let admin: MikroORM | undefined;
let orm: MikroORM | undefined;
let databaseCreated = false;
let databaseUrl = "";

function database(): MikroORM {
  if (orm === undefined) {
    throw new Error("Banco de teste não inicializado.");
  }

  return orm;
}

beforeAll(async () => {
  admin = await MikroORM.init(config);

  await admin.em.getConnection().execute(
    `CREATE DATABASE "${databaseName}"`,
  );
  databaseCreated = true;

  const url = new URL(config.clientUrl!);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  orm = await MikroORM.init({
    ...config,
    clientUrl: databaseUrl,
  });

  await orm.getMigrator().up();
}, 30_000);

afterAll(async () => {
  try {
    await orm?.close(true);
  } finally {
    try {
      if (admin !== undefined && databaseCreated) {
        await admin.em.getConnection().execute(
          `DROP DATABASE "${databaseName}" WITH (FORCE)`,
        );
      }
    } finally {
      try {
        await admin?.close(true);
      } finally {
        client.destroy();
      }
    }
  }
}, 30_000);

function spawnConsumer(
  queueUrl: string,
  mode: "crash" | "resume",
) {
  return Bun.spawn({
    cmd: [process.execPath, fixturePath],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CRASH_TEST_QUEUE_URL: queueUrl,
      CRASH_TEST_MODE: mode,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
}

async function waitForCrashPoint(
  stdout: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function readMarker(): Promise<string> {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        throw new Error(
          "O processo terminou antes de chegar ao ponto de queda.",
        );
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf("\n");

      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line.startsWith("CRASH_READY ")) {
          const marker: unknown = JSON.parse(
            line.slice("CRASH_READY ".length),
          );

          if (
            typeof marker !== "object" ||
            marker === null ||
            !("receiptHandle" in marker) ||
            typeof marker.receiptHandle !== "string"
          ) {
            throw new Error("Marcador de queda inválido.");
          }

          return marker.receiptHandle;
        }

        newline = buffer.indexOf("\n");
      }
    }
  }

  try {
    return await Promise.race([
      readMarker(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              "O processo não chegou ao ponto de queda em 15 segundos.",
            ),
          );
        }, 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    await reader.cancel().catch(() => {});
  }
}

interface FinancialState {
  balance: string;
  ledger_balance: string;
  version: number;
  entries: string;
  transactions: string;
  inbox_messages: string;
  events: string;
}

async function state(
  walletId: string,
  messageId: string,
): Promise<FinancialState> {
  const rows = await database().em.fork().execute<
    FinancialState[]
  >(
    `SELECT
      w.balance,
      w.version,
      (
        SELECT COALESCE(SUM(
          CASE WHEN direction = 'CREDIT'
            THEN amount ELSE -amount END
        ), 0)::numeric(20,2)
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS ledger_balance,
      (
        SELECT count(*)
        FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS entries,
      (
        SELECT count(*)
        FROM wager_transactions
        WHERE wallet_id = w.id AND kind = 'BET'
      ) AS transactions,
      (
        SELECT count(*)
        FROM inbox_messages
        WHERE consumer_name = 'wager-transactions-v1'
          AND message_id = ?
      ) AS inbox_messages,
      (
        SELECT count(*)
        FROM outbox_events
        WHERE payload->'data'->>'walletId' = w.id::text
          AND payload->'data'->>'transactionId' IN (
            SELECT id::text
            FROM wager_transactions
            WHERE wallet_id = w.id AND kind = 'BET'
          )
      ) AS events
    FROM wallets w
    WHERE w.id = ?`,
    [messageId, walletId],
  );

  const row = rows[0];

  if (row === undefined) {
    throw new Error("Carteira do teste não encontrada.");
  }

  return row;
}

describe("Recuperação após queda — PostgreSQL e SQS reais", () => {
  test("queda após commit e antes do ack não repete o débito no reinício", async () => {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: `crash-${crypto.randomUUID()}.fifo`,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
        },
      }),
    );

    const queueUrl = created.QueueUrl;

    if (!queueUrl) {
      throw new Error("Fila de teste não foi criada.");
    }

    let crashed: ReturnType<typeof spawnConsumer> | undefined;
    let resumed: ReturnType<typeof spawnConsumer> | undefined;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const playerId = crypto.randomUUID();

      const wallet = await new CreateWallet(
        new MikroOrmWalletOpeningStore(database()),
      ).execute({
        playerId,
        initialBalance: {
          amount: "100.00",
          currency: "BRL",
        },
      });

      const messageId = crypto.randomUUID();

      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: messageId,
          MessageBody: JSON.stringify({
            messageId,
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            data: {
              providerId: "provider-crash-test",
              externalTransactionId: messageId,
              idempotencyKey: messageId,
              playerId,
              walletId: wallet.id,
              roundId: crypto.randomUUID(),
              gameId: "game-crash-test",
              kind: "BET",
              money: {
                amount: "25.00",
                currency: "BRL",
              },
            },
          }),
        }),
      );

      crashed = spawnConsumer(queueUrl, "crash");

      const receiptHandle = await waitForCrashPoint(
        crashed.stdout,
      );

      // Confere o estado persistido antes de matar o processo.
      const committed = await state(wallet.id, messageId);

      expect(committed).toEqual({
        balance: "75.00",
        ledger_balance: "75.00",
        version: 2,
        entries: "2",
        transactions: "1",
        inbox_messages: "1",
        events: "2",
      });

      crashed.kill("SIGKILL");
      await crashed.exited;

      // Antecipa a expiração da invisibilidade para o teste
      // não precisar aguardar os 60 segundos de produção.
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );

      resumed = spawnConsumer(queueUrl, "resume");

      const resumedProcess = resumed;

      resumeTimer = setTimeout(() => {
        resumedProcess.kill("SIGKILL");
      }, 15_000);

      const output = await new Response(
        resumed.stdout,
      ).text();

      const exitCode = await resumed.exited;

      clearTimeout(resumeTimer);
      resumeTimer = undefined;

      expect(exitCode).toBe(0);
      expect(output).toContain("CONSUME_RESULT duplicate");

      // O novo processo reconheceu a duplicata e não
      // criou outro débito, transação ou evento.
      expect(await state(wallet.id, messageId))
        .toEqual(committed);

      const remaining = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );

      expect(remaining.Messages ?? []).toHaveLength(0);
    } finally {
      if (resumeTimer !== undefined) {
        clearTimeout(resumeTimer);
      }

      try {
        if (crashed !== undefined && crashed.exitCode === null) {
          crashed.kill("SIGKILL");
          await crashed.exited;
        }

        if (resumed !== undefined && resumed.exitCode === null) {
          resumed.kill("SIGKILL");
          await resumed.exited;
        }
      } finally {
        await client.send(
          new DeleteQueueCommand({
            QueueUrl: queueUrl,
          }),
        );
      }
    }
  }, 45_000);
});
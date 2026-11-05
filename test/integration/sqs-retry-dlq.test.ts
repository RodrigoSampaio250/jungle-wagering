import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/create-wallet";
import { SubmitWager } from "../../src/application/submit-wager";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { InboxExecutor } from "../../src/infrastructure/database/inbox-executor";
import { MikroOrmWagerProcessor } from "../../src/infrastructure/database/mikro-orm-wager-processor";
import { MikroOrmWalletOpeningStore } from "../../src/infrastructure/database/mikro-orm-wallet-opening.store";
import { SqsInboxConsumer } from "../../src/infrastructure/messaging/sqs-inbox-consumer";
import {
  createWagerConsumer,
  decodeWagerMessage,
} from "../../src/infrastructure/messaging/wager-consumer";

const databaseName =
  `wagering_test_${crypto.randomUUID().replaceAll("-", "")}`;

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

const queueUrls: string[] = [];

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

  orm = await MikroORM.init({
    ...config,
    clientUrl: url.toString(),
  });

  await orm.getMigrator().up();
}, 30_000);

afterAll(async () => {
  try {
    await Promise.allSettled(
      queueUrls.map((queueUrl) =>
        client.send(
          new DeleteQueueCommand({
            QueueUrl: queueUrl,
          }),
        ),
      ),
    );
  } finally {
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
  }
}, 30_000);

async function createQueue(
  label: string,
  attributes: Record<string, string> = {},
): Promise<string> {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: `${label}-${crypto.randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        ...attributes,
      },
    }),
  );

  if (!result.QueueUrl) {
    throw new Error("Fila de teste não foi criada.");
  }

  queueUrls.push(result.QueueUrl);

  return result.QueueUrl;
}

async function send(
  queueUrl: string,
  body: string,
  messageId: string,
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: messageId,
      MessageDeduplicationId: messageId,
    }),
  );
}

interface FinancialState {
  balance: string;
  ledger_balance: string;
  version: number;
  entries: string;
  bets: string;
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
        SELECT count(*) FROM wallet_ledger_entries
        WHERE wallet_id = w.id
      ) AS entries,
      (
        SELECT count(*) FROM wager_transactions
        WHERE wallet_id = w.id AND kind = 'BET'
      ) AS bets,
      (
        SELECT count(*) FROM inbox_messages
        WHERE consumer_name = 'retry-test'
          AND message_id = ?
      ) AS inbox_messages,
      (
        SELECT count(*) FROM outbox_events
        WHERE payload->'data'->>'walletId' = w.id::text
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

describe("Retry e DLQ — PostgreSQL e SQS reais", () => {
  test("falha transitória desfaz o débito e reentrega após backoff", async () => {
    const queueUrl = await createQueue("retry");
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

    await send(
      queueUrl,
      JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-retry",
          externalTransactionId: messageId,
          idempotencyKey: messageId,
          playerId,
          walletId: wallet.id,
          roundId: crypto.randomUUID(),
          gameId: "game-retry",
          kind: "BET",
          money: {
            amount: "25.00",
            currency: "BRL",
          },
        },
      }),
      messageId,
    );

    let calls = 0;

    const consumer = new SqsInboxConsumer(
      client,
      queueUrl,
      "retry-test",
      new InboxExecutor(database()),
      decodeWagerMessage,
      async (em, payload) => {
        calls += 1;

        await new SubmitWager(
          new MikroOrmWagerProcessor(database(), em),
        ).execute(payload);

        if (calls === 1) {
          throw new Error("simulated_transient_failure");
        }
      },
    );

    await expect(
      consumer.consumeOne(2),
    ).rejects.toThrow("simulated_transient_failure");

    expect(await state(wallet.id, messageId)).toEqual({
      balance: "100.00",
      ledger_balance: "100.00",
      version: 1,
      entries: "1",
      bets: "0",
      inbox_messages: "0",
      events: "2",
    });

    // Consulta os atributos sem consumir a mensagem.
    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );

    expect(
      attributes.Attributes
        ?.ApproximateNumberOfMessagesNotVisible,
    ).toBe("1");

    // Aguarda reentrega natural, sem antecipar visibilidade.
    let processed = false;
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      const result = await consumer.consumeOne(1);

      if (result === "processed") {
        processed = true;
        break;
      }
    }

    expect(processed).toBe(true);
    expect(calls).toBe(2);

    expect(await state(wallet.id, messageId)).toEqual({
      balance: "75.00",
      ledger_balance: "75.00",
      version: 2,
      entries: "2",
      bets: "1",
      inbox_messages: "1",
      events: "4",
    });

    expect(await consumer.consumeOne(1)).toBe("empty");
  }, 30_000);

  test("mensagem inválida vai para DLQ após o limite de recebimentos", async () => {
    const dlqUrl = await createQueue("invalid-dlq");

    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );

    const dlqArn = attributes.Attributes?.QueueArn;

    if (!dlqArn) {
      throw new Error("ARN da DLQ não encontrado.");
    }

    const queueUrl = await createQueue("invalid-source", {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: "2",
      }),
    });

    const messageId = crypto.randomUUID();
    const invalidBody = '{"broken":';

    await send(queueUrl, invalidBody, messageId);

    const consumer = createWagerConsumer(
      client,
      queueUrl,
      database(),
    );

    let failures = 0;
    let receivedBody: string | undefined;
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      try {
        await consumer.consumeOne(1);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(SyntaxError);
        failures += 1;
      }

      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );

      if (response.Messages?.[0] !== undefined) {
        receivedBody = response.Messages[0].Body;
        break;
      }
    }

    expect(failures).toBe(2);
    expect(receivedBody).toBe(invalidBody);
    expect(await consumer.consumeOne(1)).toBe("empty");

    const rows = await database().em.fork().execute<
      { count: string }[]
    >(
      `SELECT count(*) AS count
       FROM inbox_messages
       WHERE consumer_name = 'wager-transactions-v1'`,
    );

    expect(rows[0]?.count).toBe("0");
  }, 30_000);
});
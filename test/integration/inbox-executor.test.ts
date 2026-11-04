import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../src/infrastructure/database/mikro-orm.config";
import {
  InboxExecutor,
  InboxPayloadConflictError,
} from "../../src/infrastructure/database/inbox-executor";
import { InboxMessageRecord } from "../../src/infrastructure/database/inbox-message.record";

const databaseName =
  `wagering_test_${crypto.randomUUID().replaceAll("-", "")}`;

let admin: MikroORM | undefined;
let orm: MikroORM | undefined;
let databaseCreated = false;

function database(): MikroORM {
  if (!orm) {
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
}, 30_000);

describe("InboxExecutor — PostgreSQL real", () => {
  test("20 entregas concorrentes executam o handler uma única vez", async () => {
    const messageId = crypto.randomUUID();
    const payloadHash = "a".repeat(64);
    let calls = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        new InboxExecutor(database()).execute(
          "consumer-test",
          messageId,
          payloadHash,
          async () => {
            calls += 1;
          },
        ),
      ),
    );

    expect(calls).toBe(1);
    expect(
      results.filter((result) => result === "processed"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result === "duplicate"),
    ).toHaveLength(19);

    expect(
      await database().em.fork().count(InboxMessageRecord, {
        consumerName: "consumer-test",
        messageId,
      }),
    ).toBe(1);
  });

  test("mesma identidade com outro hash gera conflito", async () => {
    const executor = new InboxExecutor(database());
    const messageId = crypto.randomUUID();

    await executor.execute(
      "consumer-test",
      messageId,
      "a".repeat(64),
      async () => {},
    );

    let called = false;

    await expect(
      executor.execute(
        "consumer-test",
        messageId,
        "b".repeat(64),
        async () => {
          called = true;
        },
      ),
    ).rejects.toBeInstanceOf(InboxPayloadConflictError);

    expect(called).toBe(false);
  });

  test("falha desfaz a reserva e os efeitos gravados pelo handler", async () => {
    const executor = new InboxExecutor(database());
    const messageId = crypto.randomUUID();
    const effectId = crypto.randomUUID();

    await expect(
      executor.execute(
        "consumer-test",
        messageId,
        "c".repeat(64),
        async (em) => {
          // Registro auxiliar para comprovar que o handler
          // usa a mesma transação da reserva.
          await em.insert(InboxMessageRecord, {
            id: effectId,
            consumerName: "handler-effect-test",
            messageId,
            payloadHash: "d".repeat(64),
            processedAt: new Date(),
          });

          throw new Error("simulated_handler_failure");
        },
      ),
    ).rejects.toThrow("simulated_handler_failure");

    const em = database().em.fork();

    expect(
      await em.count(InboxMessageRecord, {
        consumerName: "consumer-test",
        messageId,
      }),
    ).toBe(0);

    expect(
      await em.count(InboxMessageRecord, { id: effectId }),
    ).toBe(0);

    const retry = await executor.execute(
      "consumer-test",
      messageId,
      "c".repeat(64),
      async (transactionEm) => {
        await transactionEm.insert(InboxMessageRecord, {
          id: effectId,
          consumerName: "handler-effect-test",
          messageId,
          payloadHash: "d".repeat(64),
          processedAt: new Date(),
        });
      },
    );

    expect(retry).toBe("processed");

    expect(
      await database().em.fork().count(InboxMessageRecord, {
        messageId,
      }),
    ).toBe(2);
  });

  test("consumidores diferentes podem processar o mesmo evento", async () => {
        const executor = new InboxExecutor(database());
        const messageId = crypto.randomUUID();
        let calls = 0;

        for (const consumer of ["consumer-a", "consumer-b"]) {
        const result = await executor.execute(
            consumer,
            messageId,
            "e".repeat(64),
            async () => {
            calls += 1;
            },
        );

        expect(result).toBe("processed");
        }

        expect(calls).toBe(2);
    });
    });

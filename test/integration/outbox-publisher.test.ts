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
import { OutboxEventRecord } from "../../src/infrastructure/database/outbox-event.record";
import { OutboxPublisher } from "../../src/infrastructure/database/outbox-publisher";

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

beforeEach(async () => {
  // Limpa somente a outbox deste banco temporário.
  await database().em.fork().nativeDelete(OutboxEventRecord, {});
});

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

async function seedEvent(): Promise<string> {
  const id = crypto.randomUUID();
  const at = new Date();

  await database().em.fork().insert(OutboxEventRecord, {
    id,
    aggregateId: crypto.randomUUID(),
    eventType: "WagerTransactionProcessed",
    payload: {
      eventId: id,
      eventType: "WagerTransactionProcessed",
    },
    createdAt: at,
    publishedAt: null,
    attempts: 0,
    nextAttemptAt: at,
    lastError: null,
  });

  return id;
}

describe("OutboxPublisher — PostgreSQL real", () => {
  test("não chama o envio quando não há eventos", async () => {
    let calls = 0;

    const publisher = new OutboxPublisher(database(), {
      async publish() {
        calls += 1;
      },
    });

    expect(await publisher.publishOne()).toBe("empty");
    expect(calls).toBe(0);
  });

  test("marca como publicado somente depois do envio", async () => {
    const id = await seedEvent();
    const sent: string[] = [];

    const publisher = new OutboxPublisher(database(), {
      async publish(event) {
        // Outra conexão ainda enxerga o evento como não publicado.
        const duringSend = await database().em.fork().findOneOrFail(
          OutboxEventRecord,
          { id },
        );

        expect(duringSend.publishedAt).toBeNull();
        sent.push(event.id);
      },
    });

    expect(await publisher.publishOne()).toBe("published");

    const saved = await database().em.fork().findOneOrFail(
      OutboxEventRecord,
      { id },
    );

    expect(sent).toEqual([id]);
    expect(saved.publishedAt).toBeInstanceOf(Date);
    expect(saved.attempts).toBe(1);
    expect(saved.lastError).toBeNull();

    expect(await publisher.publishOne()).toBe("empty");
    expect(sent).toHaveLength(1);
  });

  test("falha agenda nova tentativa e preserva o identificador", async () => {
    const id = await seedEvent();
    const before = Date.now();

    const failing = new OutboxPublisher(database(), {
      async publish() {
        throw new Error("Fila indisponível.");
      },
    });

    expect(await failing.publishOne()).toBe("retry");

    const failed = await database().em.fork().findOneOrFail(
      OutboxEventRecord,
      { id },
    );

    expect(failed.publishedAt).toBeNull();
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("Fila indisponível.");
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(await failing.publishOne()).toBe("empty");

    // Avança o agendamento sem precisar esperar o relógio.
    await database().em.fork().nativeUpdate(
      OutboxEventRecord,
      { id },
      { nextAttemptAt: new Date(0) },
    );

    const sent: string[] = [];

    const recovered = new OutboxPublisher(database(), {
      async publish(event) {
        sent.push(event.id);
      },
    });

    expect(await recovered.publishOne()).toBe("published");
    expect(sent).toEqual([id]);

    const saved = await database().em.fork().findOneOrFail(
      OutboxEventRecord,
      { id },
    );

    expect(saved.publishedAt).toBeInstanceOf(Date);
    expect(saved.attempts).toBe(2);
    expect(saved.lastError).toBeNull();
  });

  test("publicadores concorrentes pegam eventos diferentes", async () => {
    const firstId = await seedEvent();
    const secondId = await seedEvent();

    let releaseFirst!: () => void;
    let notifyStarted!: () => void;

    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const sent: string[] = [];

    const firstPublisher = new OutboxPublisher(database(), {
      async publish(event) {
        sent.push(event.id);
        notifyStarted();

        // Mantém o primeiro evento bloqueado enquanto
        // o segundo publicador procura outro.
        await holdFirst;
      },
    });

    const secondPublisher = new OutboxPublisher(database(), {
      async publish(event) {
        sent.push(event.id);
      },
    });

    const firstRun = firstPublisher.publishOne();

    // Propaga também uma eventual falha antes do envio.
    await Promise.race([
      firstStarted,
      firstRun.then(() => {
        throw new Error("O primeiro publicador não iniciou o envio.");
      }),
    ]);

    try {
      expect(await secondPublisher.publishOne()).toBe("published");
    } finally {
      releaseFirst();
      await firstRun;
    }

    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect(sent.sort()).toEqual([firstId, secondId].sort());

    const events = await database().em.fork().find(
      OutboxEventRecord,
      {},
    );

    expect(
      events.every((event) => event.publishedAt !== null),
    ).toBe(true);

    expect(
      events.every((event) => event.attempts === 1),
    ).toBe(true);
  });
});
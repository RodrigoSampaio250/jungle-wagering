import { randomUUID } from "node:crypto";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type {
  EntityManager,
  MikroORM,
} from "@mikro-orm/postgresql";
import { InboxMessageRecord } from "./inbox-message.record";

export class InboxPayloadConflictError extends Error {
  constructor() {
    super("A mensagem já foi processada com outro payload.");
    this.name = "InboxPayloadConflictError";
  }
}

export type InboxExecutionResult = "processed" | "duplicate";

export class InboxExecutor {
  constructor(private readonly orm: MikroORM) {}

  async execute(
    consumerName: string,
    messageId: string,
    payloadHash: string,
    handler: (em: EntityManager) => Promise<void>,
  ): Promise<InboxExecutionResult> {
    if (
      !consumerName.trim() ||
      consumerName.length > 100 ||
      !messageId.trim() ||
      messageId.length > 200 ||
      !/^[a-f0-9]{64}$/.test(payloadHash)
    ) {
      throw new Error("Identificação de mensagem inválida.");
    }

    // A reserva e o efeito do handler usam a mesma transação.
    // Se qualquer etapa falhar, ambos são desfeitos.
    return this.orm.em.fork().transactional(async (em) => {
      const inserted = await em.execute<{ id: string }[]>(
        `INSERT INTO inbox_messages (
          id,
          consumer_name,
          message_id,
          payload_hash,
          processed_at
        )
        VALUES (?, ?, ?, ?, now())
        ON CONFLICT (consumer_name, message_id) DO NOTHING
        RETURNING id`,
        [randomUUID(), consumerName, messageId, payloadHash],
      );

      if (inserted.length === 0) {
        const existing = await em.findOneOrFail(
          InboxMessageRecord,
          { consumerName, messageId },
        );

        if (existing.payloadHash !== payloadHash) {
          throw new InboxPayloadConflictError();
        }

        return "duplicate";
      }

      await handler(em);

      await em.nativeUpdate(
        InboxMessageRecord,
        { consumerName, messageId },
        { processedAt: new Date() },
      );

      return "processed";
    });
  }
}
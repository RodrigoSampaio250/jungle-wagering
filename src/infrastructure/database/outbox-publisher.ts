import { LockMode } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../application/ports/event-publisher";
import { OutboxEventRecord } from "./outbox-event.record";

export type OutboxPublishResult =
  | "empty"
  | "published"
  | "retry";

export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly publisher: EventPublisher,
  ) {}

  async publishOne(): Promise<OutboxPublishResult> {
    return this.orm.em.fork().transactional(async (em) => {
      const event = await em.findOne(
        OutboxEventRecord,
        {
          publishedAt: null,
          nextAttemptAt: { $lte: new Date() },
        },
        {
          orderBy: {
            createdAt: "asc",
            id: "asc",
          },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );

      if (!event) {
        return "empty";
      }

      // SKIP LOCKED permite que outros publicadores
      // trabalhem em eventos diferentes.
      try {
        await this.publisher.publish({
          id: event.id,
          eventType: event.eventType,
          payload: event.payload,
        });
      } catch (error: unknown) {
        const attempts = event.attempts + 1;
        const delayMs = Math.min(
          60_000,
          1_000 * 2 ** Math.min(attempts - 1, 6),
        );

        await em.nativeUpdate(
          OutboxEventRecord,
          { id: event.id },
          {
            attempts,
            nextAttemptAt: new Date(Date.now() + delayMs),
            lastError:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : "Falha desconhecida ao publicar evento.",
          },
        );

        return "retry";
      }

      await em.nativeUpdate(
        OutboxEventRecord,
        { id: event.id },
        {
          publishedAt: new Date(),
          attempts: event.attempts + 1,
          lastError: null,
        },
      );

      return "published";
    });
  }
}
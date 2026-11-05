import { LockMode } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../application/ports/event-publisher";
import {
  logger,
  runWithContext,
} from "../observability/execution-context";
import {
  outboxPublicationLag,
  outboxResults,
} from "../observability/metrics";
import { OutboxEventRecord } from "./outbox-event.record";

export type OutboxPublishResult =
  | "empty"
  | "published"
  | "retry";

interface PublicationDetails {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  attempts: number;
  lagSeconds: number;
}

function objectValue(
  value: unknown,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as Record<string, unknown>;
}

function publicationDetails(
  event: OutboxEventRecord,
  at: Date,
): PublicationDetails {
  const data = objectValue(event.payload.data);

  return {
    eventId: event.id,
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    correlationId:
      typeof event.payload.correlationId === "string"
        ? event.payload.correlationId
        : event.aggregateId,
    ...(typeof data.transactionId === "string"
      ? { transactionId: data.transactionId }
      : {}),
    ...(typeof data.walletId === "string"
      ? { walletId: data.walletId }
      : {}),
    ...(typeof data.providerId === "string"
      ? { providerId: data.providerId }
      : {}),
    attempts: event.attempts + 1,
    lagSeconds: Math.max(
      0,
      (at.getTime() - event.createdAt.getTime()) / 1_000,
    ),
  };
}

export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly publisher: EventPublisher,
  ) {}

  async publishOne(): Promise<OutboxPublishResult> {
    let details: PublicationDetails | undefined;

    const result = await this.orm.em.fork()
      .transactional<OutboxPublishResult>(async (em) => {
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

        if (event === null) {
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
              nextAttemptAt: new Date(
                Date.now() + delayMs,
              ),
              lastError:
                error instanceof Error
                  ? error.message.slice(0, 1_000)
                  : "Falha desconhecida ao publicar evento.",
            },
          );

          details = publicationDetails(event, new Date());

          return "retry";
        }

        const publishedAt = new Date();

        await em.nativeUpdate(
          OutboxEventRecord,
          { id: event.id },
          {
            publishedAt,
            attempts: event.attempts + 1,
            lastError: null,
          },
        );

        details = publicationDetails(event, publishedAt);

        return "published";
      });

    // O banco já confirmou a atualização do outbox.
    if (result === "empty" || details === undefined) {
      return result;
    }

    outboxResults.inc({ result });

    if (result === "published") {
      outboxPublicationLag.observe(details.lagSeconds);
    }

    const publication = details;

    runWithContext(
      {
        correlationId: publication.correlationId,
        ...(publication.transactionId !== undefined
          ? { transactionId: publication.transactionId }
          : {}),
        ...(publication.walletId !== undefined
          ? { walletId: publication.walletId }
          : {}),
        ...(publication.providerId !== undefined
          ? { providerId: publication.providerId }
          : {}),
      },
      () => {
        const fields = {
          eventId: publication.eventId,
          eventType: publication.eventType,
          aggregateId: publication.aggregateId,
          attempts: publication.attempts,
          lagSeconds: publication.lagSeconds,
          result,
        };

        if (result === "retry") {
          logger.warn("outbox.publication.retry", fields);
        } else {
          logger.info("outbox.publication.confirmed", fields);
        }
      },
    );

    return result;
  }
}
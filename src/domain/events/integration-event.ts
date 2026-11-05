export interface IntegrationEventProps<T extends object> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: T;
}

export interface IntegrationEventEnvelope<T extends object> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<T>;
}

function deepFreeze<T>(value: T): T {
  if (
    typeof value === "object" &&
    value !== null &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(
      value as Record<string, unknown>,
    )) {
      deepFreeze(child);
    }

    Object.freeze(value);
  }

  return value;
}

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;

  private readonly occurredAtIso: string;

  protected constructor(props: IntegrationEventProps<T>) {
    if (
      !props.eventId.trim() ||
      !props.aggregateId.trim() ||
      !props.correlationId.trim()
    ) {
      throw new Error(
        "Evento exige eventId, aggregateId e correlationId.",
      );
    }

    if (
      props.causationId !== undefined &&
      !props.causationId.trim()
    ) {
      throw new Error("causationId não pode ser vazio.");
    }

    if (!Number.isFinite(props.occurredAt.getTime())) {
      throw new Error("Data do evento inválida.");
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAtIso = props.occurredAt.toISOString();

    // Copia os dados para não congelar objetos do chamador.
    this.data = deepFreeze(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtIso);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined
        ? { causationId: this.causationId }
        : {}),
      occurredAt: this.occurredAtIso,
      version: this.version,
      data: this.data,
    };
  }
}
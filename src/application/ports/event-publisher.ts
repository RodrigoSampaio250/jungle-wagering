export interface PublishableEvent {
  readonly id: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventPublisher {
  publish(event: PublishableEvent): Promise<void>;
}
import {
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  EventPublisher,
  PublishableEvent,
} from "../../application/ports/event-publisher";

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(event: PublishableEvent): Promise<void> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageAttributes: {
          eventId: {
            DataType: "String",
            StringValue: event.id,
          },
          eventType: {
            DataType: "String",
            StringValue: event.eventType,
          },
        },
      }),
    );

    if (!result.MessageId) {
      throw new Error("SQS não confirmou o envio do evento.");
    }
  }
}
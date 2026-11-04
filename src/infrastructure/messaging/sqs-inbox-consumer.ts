import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { EntityManager } from "@mikro-orm/postgresql";
import {
  InboxExecutor,
  type InboxExecutionResult,
} from "../database/inbox-executor";

export interface InboxEnvelope<T> {
  readonly messageId: string;
  readonly payloadHash: string;
  readonly payload: T;
}

export type ConsumeResult = InboxExecutionResult | "empty";

export class SqsInboxConsumer<T> {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly consumerName: string,
    private readonly inbox: InboxExecutor,
    private readonly decode: (body: string) => InboxEnvelope<T>,
    private readonly handler: (
      em: EntityManager,
      payload: T,
    ) => Promise<void>,
  ) {}

  async consumeOne(
    waitTimeSeconds = 10,
  ): Promise<ConsumeResult> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: 60,
      }),
    );

    const message = response.Messages?.[0];

    if (!message) {
      return "empty";
    }

    if (
      message.Body === undefined ||
      !message.ReceiptHandle
    ) {
      throw new Error(
        "SQS retornou mensagem sem corpo ou receipt handle.",
      );
    }

    const envelope = this.decode(message.Body);

    const result = await this.inbox.execute(
      this.consumerName,
      envelope.messageId,
      envelope.payloadHash,
      async (em) => {
        await this.handler(em, envelope.payload);
      },
    );

    // execute() só termina com sucesso depois do commit.
    // Duplicatas já confirmadas também podem ser excluídas.
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    return result;
  }
}
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

async function createQueue(
  name: string,
  fifo: boolean,
): Promise<string> {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        MessageRetentionPeriod: "1209600",
        ...(fifo
          ? {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
            }
          : {}),
      },
    }),
  );

  if (!result.QueueUrl) {
    throw new Error(`A fila ${name} não retornou uma URL.`);
  }

  return result.QueueUrl;
}

async function setupQueue(
  name: string,
  deadLetterName: string,
  fifo: boolean,
): Promise<void> {
  const deadLetterUrl = await createQueue(
    deadLetterName,
    fifo,
  );

  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetterUrl,
      AttributeNames: ["QueueArn"],
    }),
  );

  const deadLetterArn = attributes.Attributes?.QueueArn;

  if (!deadLetterArn) {
    throw new Error(`DLQ de ${name} não retornou um ARN.`);
  }

  const queueUrl = await createQueue(name, fifo);

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        VisibilityTimeout: "60",
        ReceiveMessageWaitTimeSeconds: "20",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: "5",
        }),
      },
    }),
  );

  console.log(
    JSON.stringify({
      event: "queue.configured",
      queue: name,
      queueUrl,
      deadLetterUrl,
    }),
  );
}

try {
  await setupQueue(
    "wager-transactions.fifo",
    "wager-transactions-dlq.fifo",
    true,
  );

  await setupQueue(
    "wagering-events",
    "wagering-events-dlq",
    false,
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "queue.setup_failed",
      message:
        error instanceof Error
          ? error.message
          : String(error),
    }),
  );

  process.exitCode = 1;
} finally {
  client.destroy();
}
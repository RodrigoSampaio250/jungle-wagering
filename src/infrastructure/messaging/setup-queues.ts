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
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

async function createQueue(name: string): Promise<string> {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        MessageRetentionPeriod: "1209600",
      },
    }),
  );

  if (!result.QueueUrl) {
    throw new Error(`A fila ${name} não retornou uma URL.`);
  }

  return result.QueueUrl;
}

async function setupQueue(name: string): Promise<void> {
  const deadLetterUrl = await createQueue(`${name}-dlq`);

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

  const queueUrl = await createQueue(name);

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

  console.log(JSON.stringify({
    event: "queue.configured",
    queue: name,
    queueUrl,
    deadLetterUrl,
  }));
}

try {
  await setupQueue("wagering-transactions");
  await setupQueue("wagering-events");
} catch (error: unknown) {
  console.error("Falha ao configurar filas:", error);
  process.exitCode = 1;
} finally {
  client.destroy();
}
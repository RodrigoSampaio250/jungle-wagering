import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  ListQueuesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

@Controller("health")
export class HealthController implements OnApplicationShutdown {
  private readonly sqs: SQSClient;

  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {
    this.sqs = new SQSClient({
      endpoint:
        process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 2_000,
        requestTimeout: 3_000,
      },
    });
  }

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const [database, sqs] = await Promise.allSettled([
      this.orm.em.fork().execute("SELECT 1"),
      this.sqs.send(
        new ListQueuesCommand({
          MaxResults: 1,
        }),
        {
          abortSignal: AbortSignal.timeout(3_000),
        },
      ),
    ]);

    const databaseUp = database.status === "fulfilled";
    const sqsUp = sqs.status === "fulfilled";

    const result = {
      status:
        databaseUp && sqsUp ? "ok" : "unavailable",
      database: databaseUp ? "up" : "down",
      sqs: sqsUp ? "up" : "down",
    };

    if (!databaseUp || !sqsUp) {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
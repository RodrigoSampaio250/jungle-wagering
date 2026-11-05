import { strict as assert } from "node:assert";
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

interface WalletResponse {
  id: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

interface ReconciliationResponse {
  storedBalance: {
    amount: string;
    currency: string;
  };
  calculatedBalance: {
    amount: string;
    currency: string;
  };
  difference: {
    amount: string;
    currency: string;
  };
  consistent: boolean;
  checkedEntries: number;
}

const baseUrl = "http://localhost:3001";

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });

  const body: unknown = await response.json();

  assert.ok(
    response.ok,
    `HTTP ${response.status}: ${JSON.stringify(body)}`,
  );

  return body as T;
}

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

try {
  const playerId = crypto.randomUUID();

  const wallet = await request<WalletResponse>("/wallets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      playerId,
      initialBalance: {
        amount: "100.00",
        currency: "BRL",
      },
    }),
  });

  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({
      QueueName: "wager-transactions.fifo",
    }),
  );

  assert.ok(QueueUrl, "A fila FIFO deve existir.");

  const messageId = crypto.randomUUID();

  const envelope = {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-fifo-check",
      externalTransactionId: messageId,
      idempotencyKey: `provider-fifo-check:${messageId}`,
      playerId,
      walletId: wallet.id,
      roundId: crypto.randomUUID(),
      gameId: "game-fifo-check",
      kind: "BET",
      money: {
        amount: "25.00",
        currency: "BRL",
      },
    },
  };

  for (const delivery of [1, 2]) {
    await client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wallet.id,

        // Neste teste, IDs diferentes forçam duas entregas.
        // Assim, verificamos a inbox sem depender da
        // deduplicação temporária do broker.
        MessageDeduplicationId: `${messageId}:${delivery}`,
      }),
    );
  }

  let processed = false;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await request<WalletResponse>(
      `/wallets/${wallet.id}`,
    );

    if (current.balance.amount === "75.00") {
      assert.equal(current.version, 2);
      processed = true;
      break;
    }

    assert.equal(current.balance.amount, "100.00");

    await Bun.sleep(500);
  }

  assert.ok(
    processed,
    "O worker não aplicou a aposta dentro do prazo.",
  );

  const reconciliation =
    await request<ReconciliationResponse>(
      `/wallets/${wallet.id}/reconciliation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

  assert.equal(reconciliation.consistent, true);
  assert.equal(reconciliation.storedBalance.amount, "75.00");
  assert.equal(reconciliation.calculatedBalance.amount, "75.00");
  assert.equal(reconciliation.difference.amount, "0.00");
  assert.equal(reconciliation.checkedEntries, 2);

  console.log(
    JSON.stringify({
      event: "fifo.check_passed",
      messageId,
      walletId: wallet.id,
      submittedCopies: 2,
      balance: "75.00",
      consistent: true,
    }),
  );
} finally {
  client.destroy();
}
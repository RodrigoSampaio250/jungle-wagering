import { strict as assert } from "node:assert";

interface WalletResponse {
  id: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

interface TransactionResponse {
  transactionId: string;
  status: string;
  balance: {
    amount: string;
    currency: string;
  } | null;
  idempotentReplay: boolean;
}

interface ReconciliationResponse {
  consistent: boolean;
  difference: string;
  entryCount: string;
}

const bases = [
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
];

async function request<T>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });

  const body: unknown = await response.json();

  assert.ok(
    response.ok,
    `HTTP ${response.status}: ${JSON.stringify(body)}`,
  );

  return body as T;
}

const playerId = crypto.randomUUID();

const wallet = await request<WalletResponse>(
  bases[0]!,
  "/wallets",
  {
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
  },
);

const key = crypto.randomUUID();

const payload = {
  providerId: "provider-multi-instance",
  externalTransactionId: key,
  playerId,
  walletId: wallet.id,
  roundId: crypto.randomUUID(),
  gameId: "game-multi-instance",
  kind: "BET",
  money: {
    amount: "25.00",
    currency: "BRL",
  },
};

const results: TransactionResponse[] = await Promise.all(
  Array.from({ length: 30 }, (_, index) => {
    const base = bases[index % bases.length]!;

    return request<TransactionResponse>(
      base,
      "/transactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(payload),
      },
    );
  }),
);

assert.equal(
  new Set(
    results.map((result) => result.transactionId),
  ).size,
  1,
  "Todas as respostas devem apontar para a mesma transação.",
);

assert.equal(
  results.filter(
    (result) => result.idempotentReplay === false,
  ).length,
  1,
  "Apenas uma requisição deve processar a aposta.",
);

assert.equal(
  results.filter(
    (result) => result.idempotentReplay === true,
  ).length,
  29,
  "As outras 29 requisições devem retornar replay.",
);

for (const result of results) {
  assert.equal(result.status, "PROCESSED");

  assert.ok(
    result.balance,
    "Transação processada deve retornar saldo.",
  );

  assert.equal(result.balance.amount, "75.00");
  assert.equal(result.balance.currency, "BRL");
}

for (const base of bases) {
  const current = await request<WalletResponse>(
    base,
    `/wallets/${wallet.id}`,
  );

  assert.equal(current.balance.amount, "75.00");
  assert.equal(current.version, 2);

  const reconciliation =
    await request<ReconciliationResponse>(
      base,
      `/wallets/${wallet.id}/reconciliation`,
    );

  assert.equal(reconciliation.consistent, true);
  assert.equal(reconciliation.difference, "0.00");
  assert.equal(reconciliation.entryCount, "2");
}

console.log(
  JSON.stringify({
    event: "multi_instance.check_passed",
    requests: results.length,
    instances: bases.length,
    processed: 1,
    replays: 29,
    balance: "75.00",
    walletId: wallet.id,
  }),
);
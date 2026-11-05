# Jungle Wagering

Serviço de processamento de apostas desenvolvido para o desafio de Backend da Jungle Gaming.

Minha prioridade foi manter o dinheiro correto quando uma operação chega repetida, duas apostas disputam saldo ou um processo cai antes de confirmar a mensagem. As garantias financeiras ficam no PostgreSQL. A fila transporta o trabalho, e a aplicação trata suas reentregas.

As decisões e os limites da implementação estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Componente | Versão |
| --- | --- |
| Bun | 1.4.4 |
| TypeScript | 5.9.3, modo estrito |
| NestJS | 11.2.8 |
| PostgreSQL | 17.6 |
| MikroORM | 6.6.17 |
| LocalStack | 4.14.0 |
| AWS SDK SQS | 3.1161.0 |
| decimal.js | 10.6.0 |
| prom-client | 15.1.3 |

## Executar com Docker

É necessário ter Docker com Compose. Para executar testes e scripts na máquina, também é necessário Bun 1.4.4.

```bash
git clone https://github.com/RodrigoSampaio250/jungle-wagering.git
cd jungle-wagering
docker compose up -d --build
docker compose ps -a
```

O Compose sobe PostgreSQL e LocalStack, aplica as migrations e configura as filas. As três APIs e os workers aguardam essas tarefas terminarem com sucesso.

`migrate` e `setup-queues` devem terminar com `Exited (0)`. As APIs devem ficar `healthy`; os workers permanecem em execução.

| Serviço | Endereço local |
| --- | --- |
| API 1 | http://localhost:3001 |
| API 2 | http://localhost:3002 |
| API 3 | http://localhost:3003 |
| PostgreSQL | 127.0.0.1:5432 |
| LocalStack | http://localhost:4566 |
| Métricas do wager worker | http://localhost:9101/metrics |
| Métricas do outbox worker | http://localhost:9102/metrics |
| Métricas do reference worker | http://localhost:9103/metrics |

```bash
curl -i http://localhost:3001/health/live
curl -i http://localhost:3001/health/ready
curl -i http://localhost:3002/health/ready
curl -i http://localhost:3003/health/ready
```

Liveness verifica o processo. Readiness consulta PostgreSQL e SQS e retorna 503 se alguma dessas verificações falhar.

O ambiente usa credenciais locais de desenvolvimento definidas no Compose. A autenticação HTTP é permissiva nesta entrega; `ProviderAuthGuard` é o ponto de extensão para uma implementação real.

Para parar os serviços preservando o volume do PostgreSQL:

```bash
docker compose down
```

## Configuração

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL; no host, o padrão usa `127.0.0.1:5432` e banco `wagering` |
| `SQS_ENDPOINT` | Endpoint SQS; no host, o padrão é `http://127.0.0.1:4566` |
| `AWS_REGION` | Região SQS; padrão `us-east-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credenciais locais do SQS |
| `REFERENCE_TTL_MS` | Prazo de espera da referência; padrão de uma hora no Compose |
| `SERVICE_NAME` | Identificação do processo nos logs e métricas |
| `METRICS_PORT` | Porta interna de métricas dos workers; padrão `9100` |

Para desenvolver a API no host, com banco e filas preparados:

```bash
bun install --frozen-lockfile
bun run dev
```

A API no host usa a porta 3000. As APIs do Compose usam 3001, 3002 e 3003 na máquina. Ao executar vários workers diretamente no host, defina uma `METRICS_PORT` diferente para cada processo.

## Testes

Com PostgreSQL e LocalStack disponíveis:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

A última execução validada passou com **142 testes, zero falhas e 496 verificações, em 16 arquivos**. Isso registra a execução realizada; não representa uma medição de cobertura de linhas ou de desempenho.

Os testes de integração criam bancos temporários. O usuário de teste precisa poder criar e remover bancos, como acontece na configuração local do Compose. Execute a suíte em ambiente de desenvolvimento ou teste.

Dois cenários podem ser executados separadamente:

```bash
bun test test/integration/crash-recovery.test.ts
bun test test/integration/migrations.test.ts
```

O primeiro cria uma fila FIFO exclusiva e um banco temporário. Um processo filho confirma o débito e é encerrado antes do ack. Outro processo recebe a mensagem como duplicata, sem repetir saldo, ledger, transação ou eventos. O teste antecipa a visibilidade da mensagem para não esperar os 60 segundos configurados no consumidor.

O segundo aplica as cinco migrations, cria uma carteira, reverte todas, reaplica e verifica novamente a persistência.

### Validações com os serviços completos

```bash
bun test/multi-instance-check.ts
bun test/fifo-check.ts
```

O primeiro script distribui 30 cópias da mesma aposta entre as três APIs: uma operação aplicada, 29 replays e saldo final de `75.00 BRL` sobre uma abertura de `100.00 BRL`.

O segundo envia duas mensagens com a mesma identidade de aplicação e IDs distintos de deduplicação do SQS, para exercitar a inbox. Ele verifica saldo `75.00`, versão 2 e reconciliação consistente. Os resultados `processed` e `duplicate` podem ser conferidos nos logs e métricas do worker.

Esses scripts criam carteiras novas e dependem do Compose completo. Não fazem parte da descoberta padrão de `bun test`.

## API HTTP

| Método | Caminho | Finalidade |
| --- | --- | --- |
| POST | `/wallets` | Criar carteira |
| GET | `/wallets/:id` | Consultar carteira |
| GET | `/wallets/:id/ledger` | Consultar lançamentos com cursor |
| POST | `/wagering/transactions` | Submeter operação |
| GET | `/wagering/transactions/:id` | Consultar transação |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar identidade externa |
| POST | `/wallets/:id/reconciliation` | Comparar saldo persistido e ledger |
| GET | `/health/live` | Liveness |
| GET | `/health/ready` | Readiness |
| GET | `/metrics` | Métricas da instância da API |

Os caminhos antigos `/transactions`, seus lookups e o GET de reconciliação continuam como aliases de compatibilidade. Os exemplos abaixo usam o contrato principal.

### Criar carteira

```bash
curl -i -X POST http://localhost:3001/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "00000000-0000-4000-8000-000000000301",
    "initialBalance": {"amount": "100.00", "currency": "BRL"}
  }'
```

Guarde o `id` retornado. Uma abertura positiva cria `OPENING`, crédito no ledger e eventos na mesma transação SQL. Uma abertura zerada cria apenas a carteira. Jogador e moeda identificam uma carteira única.

### Submeter aposta

Substitua `WALLET_ID` pelo identificador retornado:

```bash
curl -i -X POST http://localhost:3001/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:readme-bet-001' \
  -H 'X-Correlation-Id: readme-bet-001' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "readme-bet-001",
    "playerId": "00000000-0000-4000-8000-000000000301",
    "walletId": "WALLET_ID",
    "roundId": "readme-round-001",
    "gameId": "readme-game",
    "kind": "BET",
    "money": {"amount": "25.00", "currency": "BRL"}
  }'
```

Dinheiro usa strings com duas casas decimais. Repetir chave e payload retorna o resultado original com `idempotentReplay: true`; alterar o payload mantendo a chave retorna 409. O header é obrigatório.

| Resultado da submissão | HTTP |
| --- | --- |
| Processada | 200 |
| Pendente ou aguardando referência | 202 |
| Rejeição de negócio | 422 |
| Conflito de identidade ou idempotência | 409 |
| Entrada inválida | 400 |
| Indisponibilidade transitória reconhecida no processamento | 503 |
| Resultado `FAILED` ou erro interno não tratado | 500 |

### Consultar e reconciliar

```bash
curl -s http://localhost:3001/wallets/WALLET_ID
curl -s 'http://localhost:3001/wallets/WALLET_ID/ledger?limit=50'
curl -s http://localhost:3001/wagering/transactions/TRANSACTION_ID
curl -s http://localhost:3001/providers/provider-a/wagering/transactions/readme-bet-001
curl -s -X POST http://localhost:3001/wallets/WALLET_ID/reconciliation
```

O ledger retorna `nextCursor`. Envie esse valor em `cursor` para continuar; o cliente não precisa interpretá-lo.

A reconciliação retorna `storedBalance`, `calculatedBalance` e `difference` como objetos monetários, além de `consistent` e `checkedEntries`. Uma divergência produz log e métrica, sem correção automática.

## Filas e eventos

| Fila | Tipo |
| --- | --- |
| `wager-transactions.fifo` | Entrada FIFO |
| `wager-transactions-dlq.fifo` | DLQ FIFO da entrada |
| `wagering-events` | Saída standard |
| `wagering-events-dlq` | DLQ standard da saída |

Envelope de entrada; substitua os UUIDs pelos valores da operação:

```json
{
  "messageId": "IDENTIDADE_ESTAVEL_DA_MENSAGEM",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-05T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-001",
    "idempotencyKey": "provider-a:bet-001",
    "playerId": "PLAYER_UUID",
    "walletId": "WALLET_UUID",
    "roundId": "round-001",
    "gameId": "game-001",
    "kind": "BET",
    "money": {"amount": "25.00", "currency": "BRL"}
  }
}
```

No envio FIFO, use a carteira como `MessageGroupId` e informe `MessageDeduplicationId`. A deduplicação persistente continua sendo responsabilidade da aplicação e do PostgreSQL.

Os eventos usam uma classe abstrata e subclasses concretas: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` e `WagerTransactionFailed`. O envelope inclui identidade, tipo, agregado, correlação, data, versão e dados. `causationId` é opcional e não é preenchido pelo fluxo atual.

`LOSS` gera evento de processamento sem alterar saldo ou gerar lançamento. `WalletBalanceChanged` acompanha movimentações efetivas. Retentativas de referência não repetem o evento de pendência.

## Workers e observabilidade

| Worker | Responsabilidade |
| --- | --- |
| `wager-worker` | Inbox, processamento financeiro e ack após commit |
| `outbox-worker` | Publicação de eventos e reagendamento após falha |
| `reference-worker` | Retomada e expiração de referências |

```bash
docker compose logs --tail=40 wager-worker outbox-worker reference-worker
curl -fsS http://localhost:3001/metrics
curl -fsS http://localhost:9101/metrics
curl -fsS http://localhost:9102/metrics
curl -fsS http://localhost:9103/metrics
```

Cada processo mantém suas próprias métricas. Os contadores reiniciam com ele; não substituem o ledger nem são um histórico financeiro persistente. Não há servidor Prometheus ou dashboard incluído no Compose.

Há métricas de resultados, replay, duplicatas da inbox, reentregas, falhas por fase, publicações, lag observado na publicação, referências e divergências de reconciliação. Conflitos de lock são contados no caminho HTTP instrumentado. A DLQ expõe quantidade aproximada por estado e sucesso da consulta; ela não é consumida pela coleta.

O prazo de referência é de uma hora por padrão. Referências e publicações usam reagendamento exponencial limitado a 60 segundos. Na entrada SQS, a visibilidade é de 60 segundos e a política de redrive permite cinco recebimentos antes da DLQ; o consumidor ainda não altera a visibilidade com backoff exponencial por mensagem.

`SIGINT` e `SIGTERM` interrompem novas iterações e permitem concluir a operação em andamento antes de fechar as conexões. Os limites de rastreabilidade e os cenários ainda não automatizados estão detalhados no documento de arquitetura.

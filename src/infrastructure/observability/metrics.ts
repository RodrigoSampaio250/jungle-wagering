import {
  Counter,
  Histogram,
  Registry,
} from "prom-client";

export const metricsRegistry = new Registry();

metricsRegistry.setDefaultLabels({
  service: process.env.SERVICE_NAME ?? "jungle-wagering",
});

export const transactionResults = new Counter({
  name: "wagering_transaction_results_total",
  help: "Resultados das chamadas de processamento de transações.",
  labelNames: ["status", "replay"] as const,
  registers: [metricsRegistry],
});

export const transactionDuration = new Histogram({
  name: "wagering_transaction_duration_seconds",
  help: "Duração das chamadas de processamento de transações.",
  buckets: [
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1,
    2.5,
    5,
    10,
  ],
  registers: [metricsRegistry],
});

export const inboxResults = new Counter({
  name: "wagering_inbox_results_total",
  help: "Execuções confirmadas do inbox, incluindo duplicatas.",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const messageFailures = new Counter({
  name: "wagering_message_failures_total",
  help: "Falhas no consumo de mensagens por fase.",
  labelNames: ["phase"] as const,
  registers: [metricsRegistry],
});

export const messageRedeliveries = new Counter({
  name: "wagering_message_redeliveries_total",
  help: "Recebimentos de mensagens com receive count maior que um.",
  registers: [metricsRegistry],
});

export const outboxResults = new Counter({
  name: "wagering_outbox_results_total",
  help: "Tentativas de publicação de eventos do outbox.",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const outboxPublicationLag = new Histogram({
  name: "wagering_outbox_publication_lag_seconds",
  help: "Tempo entre a criação do evento e sua publicação confirmada.",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 900, 3600],
  registers: [metricsRegistry],
});

export const referenceResults = new Counter({
  name: "wagering_reference_results_total",
  help: "Resultados das tentativas de resolver referências pendentes.",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const lockConflicts = new Counter({
  name: "wagering_database_lock_conflicts_total",
  help: "Falhas de banco por deadlock ou indisponibilidade de lock.",
  registers: [metricsRegistry],
});

export const reconciliationMismatches = new Counter({
  name: "wagering_reconciliation_mismatches_total",
  help: "Reconciliações que detectaram divergência de saldo.",
  registers: [metricsRegistry],
});

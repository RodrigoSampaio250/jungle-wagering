# Decisões de arquitetura

## Prioridade: correção financeira

Comecei pela situação que considero mais importante neste problema: uma requisição pode ser repetida, mas o débito não pode ser repetido por causa disso. Organizei o processamento para confirmar saldo, transação, ledger e eventos juntos no PostgreSQL.

Separei domínio, aplicação e infraestrutura. As regras financeiras ficam no domínio; HTTP e SQS chamam o mesmo caso de uso, `SubmitWager`. Controllers tratam o contrato HTTP e os adaptadores cuidam de persistência e transporte.

## Dinheiro

Usei `Money` como objeto de valor imutável, com construtor privado e factories. Valores entram e saem como strings decimais, e os cálculos usam `decimal.js`. Operações retornam outro objeto, preservando o original.

No PostgreSQL, os valores usam `numeric(20,2)` e são mapeados para strings. Valor e moeda ficam separados. Não converto dinheiro para `number`; versões, contadores e durações continuam numéricos porque têm outra finalidade.

Assumi escala de duas casas para BRL e USD e um limite compatível com a coluna do banco. A entrada exige formato decimal válido. Moedas incompatíveis geram erro, sem conversão implícita.

## Concorrência por carteira

Escolhi lock pessimista na linha da carteira, mantido até o fim da transação. A decisão de aceitar um débito usa o saldo lido sob esse lock.

Com duas apostas de `80.00` sobre saldo `100.00`, a primeira pode ser aplicada. A segunda avalia o saldo atualizado de `20.00` e é rejeitada. Não decide usando um saldo anterior ao lock.

O lock é por carteira. Carteiras diferentes não disputam um bloqueio global da aplicação. A contrapartida é serializar movimentações de uma carteira muito disputada. Aceitei esse custo para manter a estratégia simples e verificável.

`version` começa em 1 e acompanha alterações de saldo posteriores à abertura. Ela não é o mecanismo principal de exclusão concorrente.

## Banco como parte da garantia

Usei MikroORM com `EntitySchema`, separado das entidades de domínio. Constraints e triggers reforçam as regras além das validações da aplicação:

- Carteira única por jogador e moeda, saldo não negativo e versão válida.
- Identidades de idempotência e de transação externa únicas.
- No máximo um lançamento por carteira e transação.
- Aritmética do lançamento e vínculo entre ledger, carteira e transação.
- Imutabilidade do ledger e proteção de transações terminais.
- Unicidade de reversão processada por referência e tipo.
- Consistência diferida entre saldo, versão, transações e ledger no commit.

As checagens diferidas permitem inserir os componentes em etapas e validar o conjunto no commit. Uma falha deve desfazer o conjunto.

Parte dessas garantias usa SQL manual. O gerador de migrations não representa todas elas; alterações geradas precisam ser revisadas para preservar constraints e triggers. O teste de migrations aplica as cinco versões, cria dados, reverte até zero, reaplica e verifica a persistência novamente. Esse teste valida reversibilidade do schema; uma reversão que remove tabelas não preserva os dados de negócio.

## Identidades e replay

| Identidade | Responsabilidade |
| --- | --- |
| `idempotencyKey` | Reconhecer a mesma solicitação de negócio |
| `(providerId, externalTransactionId)` | Identificar uma operação externa por provedor |
| `(consumerName, messageId)` | Identificar uma entrega lógica na inbox |

No HTTP, a chave vem obrigatoriamente do header. O hash de negócio usa SHA-256 sobre JSON canônico, com chaves ordenadas recursivamente e dinheiro normalizado. Inclui provedor, identidade externa, jogador, carteira, rodada, jogo, tipo, dinheiro e referência quando presente. Exclui a chave de idempotência e metadados de transporte.

Chave existente com hash igual retorna replay; com hash diferente, conflito. Identidade externa já usada com outra chave também retorna conflito na interpretação adotada.

O resultado monetário original fica em `resultBalance`. Assim, um replay retorna o saldo daquela operação, mesmo que a carteira já tenha recebido outras movimentações.

Na inbox, o hash também considera a chave de idempotência recebida na mensagem. Isso permite detectar mudança na solicitação sob a mesma identidade de entrega.

## Inbox e commit financeiro

A inbox reserva sua identidade com `INSERT ... ON CONFLICT DO NOTHING`. Entregas concorrentes disputam uma restrição persistente. Se a primeira confirmar, as demais retornam duplicata; se ela falhar, a reserva também é desfeita.

O handler recebe o `EntityManager` transacional da inbox e o passa ao processador financeiro. Transações internas usam savepoints dentro da transação externa. Liberar um savepoint não confirma o débito antes da inbox.

O consumidor só envia `DeleteMessage` depois do commit externo. Se o processo cair nesse intervalo, o SQS pode entregar novamente, e a inbox reconhece a operação anterior.

O teste automatizado de recuperação usa PostgreSQL e SQS reais no LocalStack. Ele intercepta o ack em um processo filho, verifica o estado confirmado no banco, encerra o processo à força e inicia outro. O segundo retorna `duplicate`, mantém o estado financeiro e confirma a mensagem. A antecipação da visibilidade serve apenas para reduzir o tempo do teste.

Essa garantia evita repetir o efeito financeiro. Não representa transporte exactly-once.

## Ledger e operações

O ledger registra créditos e débitos imutáveis, com dinheiro, saldo anterior e saldo posterior. Uma abertura positiva cria uma transação interna `OPENING`, o crédito e os eventos na mesma transação SQL. A versão inicial permanece 1. Uma abertura zerada não cria lançamento de valor zero.

| Operação | Efeito |
| --- | --- |
| BET | Débito |
| WIN | Crédito |
| LOSS | Sem alteração financeira |
| REFUND de BET | Crédito de devolução |
| ROLLBACK de BET | Crédito |
| ROLLBACK de WIN ou REFUND | Débito |

Reversões validam referência, provedor, carteira, jogador, moeda, rodada, tipo, valor e reversão anterior. Se um rollback produzir saldo negativo, o resultado é `REJECTED` com `REVERSAL_INSUFFICIENT_BALANCE`.

`LOSS` registra processamento e evento sem alterar saldo, versão ou ledger. Rejeições não geram movimentação. Não implementei partidas dobradas.

## Referências fora de ordem

Uma referência ausente ou ainda pendente deixa a operação em `PENDING_REFERENCE`. O worker seleciona registros com lock e `SKIP LOCKED`, permitindo que outros workers avancem em registros diferentes.

Na retomada, o processador reconstrói o domínio e reaproveita a transação existente. O intervalo de reagendamento cresce exponencialmente até 60 segundos. O prazo padrão é de uma hora, configurável por `REFERENCE_TTL_MS`.

Escolhi esse prazo para tolerar atraso sem deixar referências inexistentes pendentes indefinidamente. É uma escolha operacional do exercício, não uma regra universal.

A expiração usa a data de criação e grava `REJECTED`, `REFERENCE_EXPIRED` e evento na mesma transação, sem movimentar dinheiro. Retentativas não repetem o evento inicial de pendência.

## Eventos e outbox

Os eventos derivam de uma classe abstrata de integração. O envelope inclui `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version`, `data` e `causationId` opcional. Os dados são imutáveis no domínio; a persistência recebe uma cópia mutável, pois o ORM processa os parâmetros recebidos.

| Evento | Momento |
| --- | --- |
| `WagerTransactionProcessed` | Processamento, inclusive LOSS e OPENING positiva |
| `WagerTransactionRejected` | Rejeição de negócio ou expiração |
| `WagerTransactionPendingReference` | Primeira entrada em espera de referência |
| `WalletBalanceChanged` | Movimentação efetiva de saldo |
| `WagerTransactionFailed` | Resultado terminal FAILED, quando produzido |

O agregado dos eventos atuais é a transação financeira. `walletId` identifica a carteira nos dados. A unicidade por agregado e tipo impede duplicação do mesmo evento para aquela transação.

O publisher seleciona registros confirmados com `FOR UPDATE SKIP LOCKED`. Mantém a transação e o lock durante o envio ao SQS. Em falha, grava tentativa e reagendamento exponencial; em sucesso, marca a publicação.

Essa escolha simplifica a coordenação, mas mantém conexão e transação abertas durante uma chamada de rede. Para outro volume ou perfil de latência, avaliaria um mecanismo de claim com prazo de concessão e recuperação de trabalho abandonado.

Se o SQS aceitar o evento e o processo cair antes de confirmar `publishedAt`, haverá possibilidade de nova publicação. O `eventId` permanece estável para permitir deduplicação no destino. O consumidor de demonstração dos eventos não implementa uma projeção financeira adicional.

## Estados e transporte

| Estado | Interpretação |
| --- | --- |
| PENDING | Operação ainda não aplicada |
| PENDING_REFERENCE | Aguarda referência |
| PROCESSED | Resultado aplicado, terminal |
| REJECTED | Violação de negócio, terminal |
| FAILED | Reservado a falha permanente de infraestrutura, terminal |

Erros de infraestrutura que lançam exceção não são automaticamente persistidos como `FAILED`. Falhas transitórias mantêm a possibilidade de nova tentativa.

A entrada usa FIFO, envelope `WagerTransactionRequested` e agrupamento por carteira no produtor de demonstração. A consistência financeira continua no PostgreSQL, mesmo diante de duplicatas ou acesso simultâneo por HTTP.

Após resultado de negócio confirmado, o consumidor pode enviar o ack. Mensagens inválidas ou execuções que falham não recebem ack e seguem a política de reentrega e redrive. A entrada usa visibilidade inicial de 60 segundos e máximo de cinco recebimentos antes da DLQ. Após falha transitória, o consumidor solicita visibilidade de 2, 4, 8 segundos e assim por diante, limitada a 300 segundos. Falhas de decodificação e conflitos ou validações de negócio lançados como exceção são classificados como permanentes e liberam a visibilidade para avançar o redrive. Resultados de rejeição retornados normalmente recebem ack. Exceções não reconhecidas são tratadas conservadoramente como transitórias, dentro do limite de recebimentos. Uma falha ao alterar a visibilidade é registrada sem substituir a exceção original.

## Logs e métricas

Usei contexto assíncrono para isolar identificadores entre execuções concorrentes. Logs operacionais incluem serviço, timestamp, nível e evento. No processamento financeiro e na fila, acrescentam identificadores disponíveis de correlação, mensagem, transação, carteira e provedor. Não registro o corpo completo da requisição ou mensagem nesses logs.

No HTTP, um `X-Correlation-Id` válido é aceito; caso contrário, é gerado outro. Na fila, o contexto usa a identidade da mensagem. Os eventos persistidos e a retomada de referências usam atualmente a transação como correlação. Portanto, ainda não há propagação de um único identificador do header HTTP por todos os estágios e eventos, nem preenchimento de `causationId`.

As métricas são locais por processo e expostas em formato Prometheus. IDs de carteira, transação e mensagem não são labels. Isso evita criar uma série para cada operação.

Resultados financeiros da fila são observados depois do commit externo. Uma função de observação retornada pelo handler atualiza métricas e logs; ela não executa efeitos financeiros. Falha nessa observação é registrada e não invalida o commit. Duplicatas barradas pelo inbox têm seu próprio contador.

O lag do outbox é observado na publicação bem-sucedida. Não representa a idade instantânea do evento pendente mais antigo. A métrica de DLQ consulta quantidades aproximadas por estado, sem consumir mensagens, e expõe sucesso da coleta. Falha de consulta não é apresentada como fila vazia.

Conflitos de lock estão instrumentados no caminho HTTP e no tratamento de falhas do consumidor SQS. Não há contagem equivalente em todos os caminhos dos workers de outbox e referências. Contadores reiniciam com o processo; para histórico e agregação entre instâncias, é necessário coletor externo. O Compose não inclui Prometheus, dashboard ou tracing distribuído.

## Autenticação

Deixei `ProviderAuthGuard` registrado globalmente como ponto de extensão. A implementação atual retorna `true`: não autentica identidades nem valida autorização. Health permanece acessível sem credenciais.

Para uma integração real, a validação pode ser substituída por API key, assinatura ou token de um IdP. Também seria necessário vincular a identidade autenticada aos provedores e recursos permitidos; `providerId` no corpo não prova identidade. Não criei tabela própria de usuários ou autenticação por senha neste escopo.

## Evidências e limites

A execução final registrada teve 144 testes passando em 17 arquivos. Há testes de dinheiro, schema, idempotência concorrente, disputa de saldo, rollback conjunto, referências, publishers concorrentes, HTTP, recuperação após queda entre commit e ack e reversibilidade das migrations.

Também foram executados scripts com três APIs reais do Compose e com duas entregas FIFO para a mesma identidade de aplicação. O teste automatizado de retry/DLQ verifica rollback financeiro após falha transitória, reentrega natural com backoff e processamento único. Outro cenário envia JSON inválido e verifica sua chegada à DLQ após duas tentativas em filas exclusivas. A configuração da aplicação permanece em cinco recebimentos. Os endpoints de métricas foram consultados por processo.

Essas evidências não demonstram uma meta de throughput ou latência sob carga. O cenário de crash usa uma fila exclusiva e um processo filho, não um encerramento aleatório de toda a composição. A classificação de indisponibilidade transitória como 503 está no caminho de submissão HTTP, sem filtro global equivalente em todos os endpoints.

Os limites operacionais acima fazem parte do estado atual da implementação. São pontos para evolução e para comparação explícita com o nível de completude exigido, sem atribuir aos testes uma garantia maior do que eles verificam.

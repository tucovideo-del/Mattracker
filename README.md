# Mat Tracker — Inspirit @ IBJJF Las Vegas

Painel em tempo real de "pra qual tatame ir agora", cruzando o roster da
Inspirit com as categorias ao vivo do bjjcompsystem.com, em múltiplos
campeonatos simultâneos.

## Rodando

```
npm install
npm start          # ou: PORT=8080 npm start
```

Abre em `http://localhost:3000` (ou a porta escolhida). Pra acessar do
celular pelo hotspot, use o IP do notebook na rede local:
`http://<ip-do-notebook>:3000`.

O estado (roster, mapeamentos, últimas lutas raspadas, log) é salvo em
`data/state.json` a cada mudança, então dá pra reiniciar o processo no meio
do evento sem perder o que já foi configurado.

## ⚠️ Calibração do parser (leia antes do dia do evento)

Este projeto foi construído num ambiente sem acesso de rede ao
`bjjcompsystem.com`, então o parser (`src/scraper.js`) **não foi validado
contra o HTML real do site** — ele foi escrito de forma defensiva, com três
estratégias em cascata (tabela → cards de bracket → varredura de texto por
"FIGHT N"/"MAT N"/horário), testadas contra HTML sintético que imita a
estrutura descrita na spec.

Antes de confiar no painel no dia do evento:

1. Suba o app com internet de verdade.
2. Pegue a URL de categorias de um dos tournaments (`/tournaments/{id}/categories`).
3. Abra `GET /api/debug/tournament?url=<url>` no navegador — confirma se a
   lista de categorias foi extraída (nomes + links).
4. Pegue a URL de uma categoria específica e abra
   `GET /api/debug/category?url=<url>` — confirma se as lutas saíram com
   `mat`, `scheduledTime`, `athletes` e `winner` preenchidos corretamente.
5. Se algum campo vier errado ou vazio, as três estratégias estão isoladas
   e comentadas em `src/scraper.js` (`strategyTableRows`,
   `strategyBracketCards`, `strategyFullTextScan`) — ajuste ali. Não deveria
   ser preciso mexer em mais nada (store, board, UI já trabalham em cima do
   formato normalizado `{fightNumber, mat, scheduledTime, athletes, winner, status}`).

Esses dois endpoints de debug não usam cache nem tocam no estado — são
seguros de chamar quantas vezes quiser durante a calibração.

## Fluxo de setup (dia do evento)

1. Abre o painel → ⚙️ (Setup)
2. Cola as URLs de `/tournaments/{id}/categories` (uma por linha) → **Buscar categorias**
   — isso varre todas as categorias dos tournaments UMA vez, procurando cada
   atleta do roster por nome (fuzzy, ignora acento: "Kaue" acha "Kauê").
3. Pra cada atleta aparecem os candidatos achados (categoria + nome no site
   + % de confiança). Card com borda tracejada amarela = confiança baixa,
   confira manualmente antes de marcar (evita pegar homônimo).
4. Marca a opção certa em cada atleta (ou "Não mapear agora") → **Salvar
   mapeamentos selecionados**. O app já busca os dados iniciais dessas
   categorias na hora.
5. A partir daí o polling em background atualiza só essas categorias a cada
   45–60s, mesmo com o Setup fechado.

Dá pra reabrir o Setup a qualquer momento pra mapear mais atletas (ex.:
categorias de sexta que só apareceram depois), editar o roster, ou ver o
histórico de resultados.

## Painel

- 🔴 **AGORA** / 🟡 **EM BREVE** (~20min) / ⚪ depois — só calculado como
  urgente pra lutas do dia da semana atual (evita alarme falso pra luta de
  sexta enquanto ainda é quinta).
- Conflito de horário: destaque vermelho quando dois atletas monitorados
  têm próxima luta com ≤20min de diferença em tatames diferentes — a
  distância entre tatames é o `|mat_a - mat_b|`, só uma referência rápida
  pra decisão de prioridade, não uma distância real do venue.
- Filtro por dia (Qui/Sex/Sáb) e por evento (World Master / CON / Kids).
- "Aguardando" = atleta ainda não mapeado ou sem próxima luta conhecida na
  chave. "Finalizados" = eliminado ou campeão.
- Timestamp "atualizado há Xs" reflete a última raspagem bem-sucedida
  (`lastPollAt`), não o refresh da tela — fica amarelo se passar de 90s sem
  atualizar, vermelho se a última rodada de polling teve erro.
- 🔔/🔕 no topo liga alerta sonoro + vibração quando um atleta entra nas
  ~3 últimas lutas da fila do tatame dele (extra da spec, seção 8).
- Botão "📸 Marcar cobertura" em cada card = modo shooter, marca que aquela
  luta específica já foi filmada/fotografada.

### Limitações conhecidas (heurísticas)

- **Campeão vs. "venceu, aguardando próxima"**: como não temos a árvore
  completa do chaveamento, o app assume campeão quando o atleta venceu a
  luta de maior número da categoria e não há próxima agendada. Perto da
  final vale conferir visualmente.
- **Posição na fila do tatame**: calculada só com as lutas da categoria
  monitorada naquele tatame — não vê o tatame inteiro (outras categorias
  não mapeadas também usam o mesmo tatame). É uma referência, não a fila
  real completa.
- **Horário sem AM/PM**: se o site não informar, hora < 8 é tratada como PM
  (ex.: "3:06" → 15:06), igual à convenção usada nos horários base da spec.

## Roster

Ponto de partida em `src/roster-default.js` (transcrito da spec). Dá pra
adicionar/remover atletas pela própria UI (Setup → Roster) sem editar
código — tudo persiste em `data/state.json`.

## Log

`GET /api/log` (ou "Histórico" no Setup) — registra automaticamente toda
luta concluída de um atleta monitorado (nome, luta, tatame, resultado,
timestamp), pra virar metadado do ingest/organização das imagens depois.

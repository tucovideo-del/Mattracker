# Mat Tracker — Inspirit @ IBJJF Las Vegas

Painel em tempo real de "pra qual tatame ir agora", cruzando o roster da
Inspirit com as categorias ao vivo do bjjcompsystem.com, em múltiplos
campeonatos simultâneos.

## Rodando

### Opção A — nuvem, sem terminal (recomendado pra venue grande)

Se celular e notebook não vão ficar na mesma rede (ex.: notebook fica numa
acomodação com wifi, celular circula pelo venue com dados móveis), publica
num serviço de nuvem — dá pra fazer tudo pelo navegador, sem instalar nada
no computador:

1. Cria conta em https://dashboard.render.com/register (dá pra entrar
   direto com login do GitHub, **não pede cartão**).
2. **New +** → **Blueprint** → conecta o repositório `tucovideo-del/mattracker`
   → escolhe a branch → Render lê o `render.yaml` deste projeto (já
   configurado no plano **free**) e monta tudo sozinho (build, start, porta).
3. Deploy. Em alguns minutos o Render te dá uma URL pública, tipo
   `https://mattracker.onrender.com`. Grátis, sem prazo de validade.
4. Abre essa URL do celular por dados móveis, de qualquer lugar do venue.

O único efeito colateral do plano free: se ninguém acessar por ~15min o
serviço "dorme", e a próxima requisição demora uns 30-50s pra acordar antes
de responder — só na primeira depois de um tempo parado. Se isso incomodar
e você quiser sempre ligado na hora, dá pra trocar `plan: free` por
`plan: starter` no `render.yaml` (~$7, só se quiser, não é obrigatório).

⚠️ Nesse plano sem disco persistente, se o Render reiniciar a instância
(depois de dormir, ou um deploy novo), o mapeamento do Setup se perde e
precisa refazer o scan — leva menos de um minuto, mas é bom saber.

### Opção B — local (mesma rede)

```
npm install
npm start          # ou: PORT=8080 npm start
```

Abre em `http://localhost:3000` (ou a porta escolhida). Pra acessar do
celular pelo hotspot, use o IP do notebook na rede local:
`http://<ip-do-notebook>:3000`. Só funciona se celular e notebook
estiverem na mesma rede o tempo todo.

O estado (roster, mapeamentos, últimas lutas raspadas, log) é salvo em
`data/state.json` a cada mudança, então dá pra reiniciar o processo no meio
do evento sem perder o que já foi configurado (em nuvem sem disco
persistente, ver aviso acima).

## Como o scan encontra os atletas (bjjcompsystem.com)

O site pagina cada `/tournaments/{id}/tournament_days/{day_id}` por
**tatame** (`?page=N`) — cada página é a agenda de UM tatame só naquele dia.

⚠️ A relação entre número da página e número do tatame **não é confiável de
calcular** — foi tentado um atalho linear (`page = tatame - tatame_da_page_1
+ 1`) baseado num exemplo confirmado ao vivo (`page=1` → Mat 35, `page=24` →
Mat 58), mas em outro torneio do mesmo evento `page=1` mostrou Mat 10 e
`page=3` mostrou Mat 9 — o número do tatame pode até **cair** conforme a
página sobe. Sem um padrão confiável, o Setup varre **todas as páginas de
cada torneio de verdade** (`discoverTournamentDayPages` em
`src/scraper.js`), lendo o tatame real do conteúdo de cada página em vez de
adivinhar pelo número dela. Mais lento (pode levar alguns minutos com os 5
torneios do evento), mas correto.

Isso só acontece na **primeira** varredura de cada URL, porém: uma vez
descoberto o mapa tatame→página de verdade (dado observado, não fórmula),
ele fica guardado em `state.matPageIndex[url]` — as próximas vezes que você
rodar o scan na mesma URL vão direto nas páginas já conhecidas em vez de
varrer tudo de novo (bem mais rápido). O botão **"Busca completa"** por
torneio sempre refaz a varredura inteira e atualiza esse cache, útil se um
tatame novo apareceu no meio do dia ou algo parece desatualizado.

`tournament-sources-default.js` também guarda `matPageOffset` quando a
relação tatame→página de um torneio foi conferida na mão (hoje só o
**World Master**: `page = tatame`, confirmado — `page=1` é o Mat 1,
`page=34` é o Mat 34) — mas isso é só **documentação**, não usado como
atalho: mesmo sabendo a relação de antemão, a *primeira* varredura de
cada URL sempre varre página por página de verdade. Um atalho que só
busca os tatames que o roster já espera pode deixar de fora um atleta
cujo tatame mudou ou cujo dado no roster está desatualizado — completude
> velocidade aqui. A velocidade vem do cache (`state.matPageIndex`, acima):
rápido na segunda varredura da mesma URL, completo e correto na primeira.

Tanto o scan quanto a busca completa (botão por torneio, útil pra forçar
uma nova varredura de um torneio específico) rodam em **background** no servidor:
o clique só inicia e a tela fica consultando o progresso a cada 2s, em vez
de segurar uma única requisição HTTP aberta o tempo todo. Isso evita erro
502 em hosts com timeout de request (Render e outros cortam conexões
paradas por ~100s, mesmo que o servidor ainda esteja processando
normalmente por trás).

Cada página de tatame **não é uma lista de lutas com horário** — é a árvore
de chave inteira daquele tatame (confirmado ao vivo em produção), achatada
em uma linha por item:

- cabeçalho de categoria: `Adult / Male / WHITE / Feather`
- nome do atleta, numa linha
- a academia dele, na linha seguinte
- vaga ainda não decidida: `Winner of Fight N, Mat M`
- marcador de rodada: `(QF)`, `(SF)`, `(F)`

O parser (`strategyBjjMatSchedule` em `src/scraper.js`) reconstrói as lutas
a partir disso: cada cabeçalho de categoria ou marcador de rodada abre uma
luta nova (2 vagas); cada vaga é um placeholder (ainda sem oponente
definido) ou um par nome+academia. Não tem horário nenhum nessa página, então
`scheduledTime` fica sempre vazio — a urgência 🔴/🟡/⚪ nessas categorias
depende só da posição na fila do tatame (a próxima luta pendente = 🔴), não
de horário previsto.

Cada página também tem chrome do site (menu, seletor de idioma, banner de
streaming, banner de cookies) espalhado em outras `<table>` da mesma
página — o parser identifica qual tabela é a chave de verdade (pontuando
por sinais de luta: cabeçalho de categoria, "Winner of Fight", marcador de
rodada) e ignora as outras, além de filtrar textos conhecidos do site
como segurança extra.

## Buscar por academia

Além de casar por nome, a seção **"3. Buscar por academia"** do Setup
procura direto pela equipe (ex. "Inspirit") em tudo que já foi escaneado —
mais confiável que adivinhar nome de atleta um por um, e acha até atleta
que ainda não está no roster (o botão "+ Adicionar e mapear" cadastra e já
confirma o mapeamento num clique só, só falta escolher dia/evento). Precisa
rodar um scan (ou Busca completa) antes pra ter dado pra procurar.

## ⚠️ Se o parser errar de novo

O parser foi calibrado contra dados reais de produção (não só HTML
sintético), mas o bjjcompsystem.com pode ter páginas com formato diferente
(ex.: uma fase que já não seja eliminação simples, ou uma categoria com
grupo/round-robin). Se o Setup continuar achando atleta errado:

1. Pega a URL exata que falhou e chama, no navegador:
   `GET /api/debug/category?url=<url-encodada>` — mostra o JSON com o que
   foi extraído (mat, athletes, teams, raw) sem tocar no estado salvo.
2. Me manda esse JSON (ou cola aqui na conversa) — é o jeito mais rápido de
   eu ver o formato real e ajustar `strategyBjjMatSchedule` em
   `src/scraper.js` (as estratégias mais antigas — tabela genérica, cards
   de bracket, varredura de texto — continuam como fallback pra formatos
   diferentes desse).

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

### Limitações conhecidas

- **Sem horário previsto**: a página de tatame real não expõe hora nenhuma
  (é a árvore de chave, não uma agenda com relógio) — `scheduledTime` fica
  sempre vazio. O 🔴 AGORA depende só de "essa é a próxima luta pendente
  nesse tatame", não de "faltam X minutos". Os badges 🟡 EM BREVE e os
  horários base do roster (spec seção 6) continuam só como referência
  inicial pré-scan.
- **Resultado (W/L) e log automático ainda não funcionam nessa página**: o
  parser da árvore de chave (`strategyBjjMatSchedule`) não tenta detectar
  vencedor ainda — ele sempre marca a luta como `scheduled`. Quando uma
  vaga "Winner of Fight N" for preenchida com um nome de verdade num poll
  seguinte, o app já vai mostrar a próxima luta certa (o atleta "avançou"
  continua funcionando), só o badge "Lutou (W/L)" e o log de resultados
  (seção 8 da spec) que não disparam nesse tipo de página ainda.
- **Posição na fila do tatame**: agora é calculada em cima da árvore de
  chave inteira daquele tatame (todas as categorias que jogam lá), então
  reflete bem quem vem antes/depois — mas a "próxima luta" de um atleta que
  ainda depende do resultado de outra partida (vaga "Winner of Fight N")
  não aparece até esse resultado sair.
- **Campeão vs. "venceu, aguardando próxima"**: heurística baseada na
  posição da luta dentro da página daquele tatame — perto da final vale
  conferir visualmente.

## Roster

Ponto de partida em `src/roster-default.js` (transcrito da spec). Dá pra
adicionar/remover atletas pela própria UI (Setup → Roster) sem editar
código — tudo persiste em `data/state.json`.

## Log

`GET /api/log` (ou "Histórico" no Setup) — registra automaticamente toda
luta concluída de um atleta monitorado (nome, luta, tatame, resultado,
timestamp), pra virar metadado do ingest/organização das imagens depois.

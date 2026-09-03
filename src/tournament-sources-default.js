'use strict';

// URLs fixas dos tournaments do evento (IBJJF Las Vegas) — não mudam
// durante o fim de semana, então ficam pré-preenchidas no Setup em vez do
// operador precisar colar toda vez. `label` é só cosmético (mostrado na
// UI); o id depois de "tournament_days" é o DIA daquele campeonato, não o
// campeonato em si — alguns campeonatos têm mais de um dia (URL própria
// por dia), então essa lista pode crescer sem precisar mexer em mais nada.
//
// `matPageOffset` (opcional): relação tatame->página CONFIRMADA na mão
// (mat = page - offset) pra esse torneio específico — não é regra geral do
// site (já provamos que não dá pra assumir isso pra todos: um torneio teve
// page=1→Mat10 e page=3→Mat9, não-linear). Só usa esse atalho quando
// alguém conferiu de verdade abrindo o link; os outros ficam null e o app
// varre página por página igual antes.
const TOURNAMENT_SOURCES = [
  { url: 'https://www.bjjcompsystem.com/tournaments/3028/tournament_days/5062', label: 'CON', matPageOffset: null },
  { url: 'https://www.bjjcompsystem.com/tournaments/3027/tournament_days/5066', label: 'World Master', matPageOffset: 0 }, // confirmado: page=1 é Mat 1, page=34 é Mat 34
  { url: 'https://www.bjjcompsystem.com/tournaments/3032/tournament_days/5064', label: 'CON Kids NoGi', matPageOffset: null },
  { url: 'https://www.bjjcompsystem.com/tournaments/3029/tournament_days/5063', label: 'CON NoGi', matPageOffset: null },
  { url: 'https://www.bjjcompsystem.com/tournaments/3030/tournament_days/5061', label: 'Novice', matPageOffset: null },
];

module.exports = { TOURNAMENT_SOURCES };

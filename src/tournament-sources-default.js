'use strict';

// URLs fixas dos tournaments do evento (IBJJF Las Vegas) — não mudam
// durante o fim de semana, então ficam pré-preenchidas no Setup em vez do
// operador precisar colar toda vez. `label` é só cosmético (mostrado na
// UI); o id depois de "tournament_days" é o DIA daquele campeonato, não o
// campeonato em si — alguns campeonatos têm mais de um dia (URL própria
// por dia), então essa lista pode crescer sem precisar mexer em mais nada.
const TOURNAMENT_SOURCES = [
  { url: 'https://www.bjjcompsystem.com/tournaments/3028/tournament_days/5062', label: 'CON' },
  { url: 'https://www.bjjcompsystem.com/tournaments/3027/tournament_days/5066', label: 'World Master' },
  { url: 'https://www.bjjcompsystem.com/tournaments/3032/tournament_days/5064', label: 'CON Kids NoGi' },
  { url: 'https://www.bjjcompsystem.com/tournaments/3029/tournament_days/5063', label: 'CON NoGi' },
  { url: 'https://www.bjjcompsystem.com/tournaments/3030/tournament_days/5061', label: 'Novice' },
];

module.exports = { TOURNAMENT_SOURCES };

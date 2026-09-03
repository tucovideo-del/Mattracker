'use strict';

// URLs fixas dos tournaments do evento (IBJJF Las Vegas) — não mudam
// durante o fim de semana, então ficam pré-preenchidas no Setup em vez do
// operador precisar colar toda vez. `label` é só cosmético (mostrado na
// UI); null = ainda não identificado, dá pra editar aqui sem afetar o
// funcionamento do app (o scan já testa TODO atleta do roster contra TODA
// URL da lista, independente de rótulo).
const TOURNAMENT_SOURCES = [
  { url: 'https://www.bjjcompsystem.com/tournaments/3028/tournament_days/5062', label: null },
  { url: 'https://www.bjjcompsystem.com/tournaments/3027/tournament_days/5066', label: null },
  { url: 'https://www.bjjcompsystem.com/tournaments/3032/tournament_days/5064', label: null },
  { url: 'https://www.bjjcompsystem.com/tournaments/3029/tournament_days/5063', label: null },
  { url: 'https://www.bjjcompsystem.com/tournaments/3030/tournament_days/5061', label: 'Novice' },
];

module.exports = { TOURNAMENT_SOURCES };

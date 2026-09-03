'use strict';

// Mapa tatame->página pré-descoberto (dado real, não fórmula) — gerado
// rodando uma varredura completa localmente (mais CPU/memória que o host
// de produção) e exportado aqui via GET /api/debug/mat-page-index, pra o
// app em produção nunca precisar refazer essa varredura pesada sozinho
// (foi isso que andou derrubando o processo no Render).
//
// Formato: { "<url do tournament_day>": { "<tatame>": <número da página> } }
// Vazio até a primeira varredura local ser feita e colada aqui — sem
// nenhuma entrada, o app simplesmente varre do zero na primeira vez,
// igual já fazia antes disso existir.
const MAT_PAGE_INDEX_SEED = {};

module.exports = { MAT_PAGE_INDEX_SEED };

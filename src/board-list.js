'use strict';

// Lista "crua" de todos os atletas do roster com status de mapeamento —
// usada pela tela de gerenciamento/roster, separada do /api/status (que é
// o painel filtrado/ordenado por urgência).

const { state } = require('./store');

function listRosterWithMappingInfo() {
  return state.roster.map((r) => {
    const mapping = state.mappings[r.id];
    return {
      ...r,
      mapped: !!(mapping && mapping.confirmed),
      mapping: mapping && mapping.confirmed ? mapping : null,
    };
  });
}

module.exports = { listRosterWithMappingInfo };

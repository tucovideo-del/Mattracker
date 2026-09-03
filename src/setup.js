'use strict';

// Fluxo de setup do dia do evento (spec seção 3): recebe as URLs dos
// tournaments, varre as categorias UMA vez procurando os atletas do roster,
// e devolve sugestões de mapeamento pra confirmação manual na UI.

const { fetchCategoriesList, fetchCategoryFights, athleteNamesFromFights } = require('./scraper');
const { findCandidates } = require('./match');
const { state, scheduleSave } = require('./store');

function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// Cache da última varredura, usado pro picker manual (homônimos / correção).
// Não precisa persistir: se o servidor reiniciar no meio do setup, refaz o scan.
let lastScan = { tournaments: [], categories: [] };

function getLastScan() {
  return lastScan;
}

async function scanTournaments(tournamentUrls) {
  const limit = pLimit(6);
  const errors = [];
  const tournaments = [];
  const allCategories = []; // {url, name, tournamentUrl, tournamentId}

  for (const input of tournamentUrls) {
    try {
      const { tournamentId, sourceUrl, categories } = await fetchCategoriesList(input);
      tournaments.push({ tournamentId, sourceUrl, categoriesCount: categories.length });
      for (const c of categories) {
        allCategories.push({ ...c, tournamentUrl: sourceUrl, tournamentId });
      }
    } catch (err) {
      errors.push({ input, stage: 'categories-list', error: err.message });
    }
  }

  const occurrences = []; // {name, categoryUrl, categoryName, tournamentUrl, tournamentId}

  await Promise.all(
    allCategories.map((cat) =>
      limit(async () => {
        try {
          const result = await fetchCategoryFights(cat.url);
          state.categories[cat.url] = {
            categoryName: result.categoryName || cat.name,
            fights: result.fights,
            fetchedAt: result.fetchedAt,
            lastError: null,
            lastErrorAt: null,
          };
          const names = athleteNamesFromFights(result.fights);
          for (const name of names) {
            occurrences.push({
              name,
              categoryUrl: cat.url,
              categoryName: result.categoryName || cat.name,
              tournamentUrl: cat.tournamentUrl,
              tournamentId: cat.tournamentId,
            });
          }
        } catch (err) {
          errors.push({ input: cat.url, stage: 'category-fights', error: err.message, categoryName: cat.name });
        }
      })
    )
  );

  lastScan = { tournaments, categories: allCategories, occurrences, scannedAt: new Date().toISOString() };
  scheduleSave();

  return { tournaments, categoriesScanned: allCategories.length, errors };
}

// Pra cada atleta do roster, sugere candidatos (categoria + nome achado no
// site) ordenados por confiança. threshold baixo de propósito — é melhor
// mostrar candidato fraco pro operador descartar do que não mostrar nada.
function suggestMappings(threshold = 0.5) {
  const occurrences = lastScan.occurrences || [];
  return state.roster.map((athlete) => {
    const byCategory = new Map(); // categoryUrl -> best occurrence match
    for (const occ of occurrences) {
      const score = findCandidates(athlete.name, [occ.name], threshold);
      if (score.length === 0) continue;
      const existing = byCategory.get(occ.categoryUrl);
      if (!existing || score[0].score > existing.score) {
        byCategory.set(occ.categoryUrl, {
          categoryUrl: occ.categoryUrl,
          categoryName: occ.categoryName,
          tournamentUrl: occ.tournamentUrl,
          tournamentId: occ.tournamentId,
          siteName: occ.name,
          score: score[0].score,
        });
      }
    }
    const candidates = [...byCategory.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    const existingMapping = state.mappings[athlete.id];
    return {
      athleteId: athlete.id,
      name: athlete.name,
      day: athlete.day,
      event: athlete.event,
      currentMapping: existingMapping && existingMapping.confirmed ? existingMapping : null,
      candidates,
    };
  });
}

function confirmMapping(athleteId, { categoryUrl, categoryName, tournamentUrl, tournamentId, siteName }) {
  if (!state.roster.some((a) => a.id === athleteId)) {
    throw new Error(`athleteId desconhecido: ${athleteId}`);
  }
  if (!categoryUrl || !siteName) {
    throw new Error('categoryUrl e siteName são obrigatórios');
  }
  state.mappings[athleteId] = {
    categoryUrl,
    categoryName: categoryName || null,
    tournamentUrl: tournamentUrl || null,
    tournamentId: tournamentId || null,
    siteName,
    confirmed: true,
    confirmedAt: new Date().toISOString(),
  };
  scheduleSave();
  return state.mappings[athleteId];
}

function clearMapping(athleteId) {
  delete state.mappings[athleteId];
  scheduleSave();
}

module.exports = { scanTournaments, suggestMappings, confirmMapping, clearMapping, getLastScan };

'use strict';

// Fluxo de setup do dia do evento (spec seção 3): recebe as URLs dos
// tournaments, varre as categorias UMA vez procurando os atletas do roster,
// e devolve sugestões de mapeamento pra confirmação manual na UI.

const {
  fetchCategoriesList,
  fetchCategoryFights,
  athleteTeamEntriesFromFights,
  categoriesUrlFromInput,
  tournamentIdFromUrl,
  isTournamentDayUrl,
  buildPageUrl,
  fetchTournamentDayPage,
  discoverTournamentDayPages,
} = require('./scraper');
const { findCandidates, normalize } = require('./match');
const { state, scheduleSave, addRosterEntry } = require('./store');

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

// Cache da última varredura, usado pro picker manual (homônimos / correção)
// e acumulado incrementalmente (scanTournaments reseta, fullScanTournament
// só complementa). Não precisa persistir: se o servidor reiniciar no meio
// do setup, refaz o scan.
let lastScan = { tournaments: [], categories: [], occurrences: [], scannedAt: null };

function getLastScan() {
  return lastScan;
}

// Registra uma página já buscada (seja de tournament_day ou do formato
// antigo) no state.categories + na lista de occurrences pro matching.
function ingestPage(p, tournamentUrl, tournamentId) {
  state.categories[p.url] = {
    categoryName: p.name,
    fights: p.fights,
    fetchedAt: new Date().toISOString(),
    lastError: null,
    lastErrorAt: null,
  };
  lastScan.categories.push({ url: p.url, name: p.name, tournamentUrl, tournamentId });
  for (const { name, team } of athleteTeamEntriesFromFights(p.fights)) {
    lastScan.occurrences.push({ name, team, categoryUrl: p.url, categoryName: p.name, tournamentUrl, tournamentId });
  }
}

// bjjcompsystem.com pagina cada tournament_day por TATAME (?page=N), com um
// offset que muda por torneio/dia (page=1 pode ser Mat 35 num torneio e Mat
// 1 noutro). Em vez de varrer página por página, buscamos só a page=1 pra
// descobrir esse offset e pulamos direto pra página de cada tatame que o
// roster já espera (`page = mat - firstMat + 1`) — bem mais rápido que
// varrer tudo. Ver fullScanTournament() pro plano B quando isso não achar
// um atleta (tatame reatribuído, ou dado do roster desatualizado).
async function scanTournaments(tournamentUrls) {
  const limit = pLimit(6);
  const errors = [];
  const tournaments = [];
  const dayTournaments = []; // { sourceUrl, tournamentId, firstMat, pages: Map(url -> page) }
  const staticCategories = []; // formato antigo (lista de categorias por link)

  lastScan = { tournaments: [], categories: [], occurrences: [], scannedAt: null };

  await Promise.all(
    tournamentUrls.map((input) =>
      limit(async () => {
        try {
          const listUrl = categoriesUrlFromInput(input);
          if (isTournamentDayUrl(listUrl)) {
            const tournamentId = tournamentIdFromUrl(listUrl);
            const pages = new Map();
            // page=1 pode não ter luta reconhecida ainda (tatame ocioso
            // nesse momento do dia) — tenta mais algumas antes de desistir
            // de calcular o offset página→tatame pra esse torneio.
            let firstMat = null;
            for (let probe = 1; probe <= 6 && firstMat == null; probe++) {
              const p = await fetchTournamentDayPage(listUrl, probe);
              pages.set(p.url, p);
              if (p.mat != null) {
                const matNum = parseInt(p.mat, 10);
                if (Number.isFinite(matNum)) firstMat = matNum - (probe - 1);
              }
            }
            tournaments.push({ tournamentId, sourceUrl: listUrl, categoriesCount: null });
            dayTournaments.push({ sourceUrl: listUrl, tournamentId, firstMat, pages });
          } else {
            const { tournamentId, sourceUrl, categories } = await fetchCategoriesList(input);
            tournaments.push({ tournamentId, sourceUrl, categoriesCount: categories.length });
            for (const c of categories) staticCategories.push({ ...c, tournamentUrl: sourceUrl, tournamentId });
          }
        } catch (err) {
          errors.push({ input, stage: 'discover', error: err.message });
        }
      })
    )
  );

  // pula direto pra página de cada tatame-base do roster, por torneio.
  const targeted = [];
  for (const dt of dayTournaments) {
    const firstMatNum = parseInt(dt.firstMat, 10);
    if (!Number.isFinite(firstMatNum)) continue; // page=1 não trouxe tatame legível
    const wantedMats = new Set(state.roster.map((a) => parseInt(a.baseMat, 10)).filter(Number.isFinite));
    for (const mat of wantedMats) {
      const page = mat - firstMatNum + 1;
      if (page >= 1) targeted.push({ dt, page });
    }
  }

  await Promise.all(
    targeted.map(({ dt, page }) =>
      limit(async () => {
        const url = buildPageUrl(dt.sourceUrl, page);
        if (dt.pages.has(url)) return; // já temos (ex.: page calculada = page 1)
        try {
          const result = await fetchTournamentDayPage(dt.sourceUrl, page);
          dt.pages.set(result.url, result);
        } catch (err) {
          errors.push({ input: dt.sourceUrl, stage: `mat-page-${page}`, error: err.message });
        }
      })
    )
  );

  for (const dt of dayTournaments) {
    for (const p of dt.pages.values()) ingestPage(p, dt.sourceUrl, dt.tournamentId);
  }

  // categorias do formato antigo (link-list) — busca as lutas de cada uma.
  await Promise.all(
    staticCategories.map((cat) =>
      limit(async () => {
        try {
          const result = cat.fights
            ? { name: cat.name, fights: cat.fights, url: cat.url }
            : { ...(await fetchCategoryFights(cat.url)), url: cat.url, name: undefined };
          ingestPage(
            { url: cat.url, name: result.categoryName || result.name || cat.name, fights: result.fights },
            cat.tournamentUrl,
            cat.tournamentId
          );
        } catch (err) {
          errors.push({ input: cat.url, stage: 'category-fights', error: err.message, categoryName: cat.name });
        }
      })
    )
  );

  lastScan.tournaments = tournaments;
  lastScan.scannedAt = new Date().toISOString();
  scheduleSave();

  return {
    tournaments,
    categoriesScanned: lastScan.categories.length,
    errors,
    tournamentDaysScanned: dayTournaments.map((dt) => dt.sourceUrl),
  };
}

// Plano B pra quando a busca direta (scanTournaments) não achar um atleta:
// varre TODAS as páginas daquele tournament_day (mais lento, mas completo).
// Só adiciona o que ainda não tínhamos — não refaz trabalho.
async function fullScanTournament(tournamentUrl) {
  const listUrl = categoriesUrlFromInput(tournamentUrl);
  if (!isTournamentDayUrl(listUrl)) {
    return { added: 0, totalPages: 0, note: 'não é uma URL de tournament_day paginada por tatame' };
  }
  const tournamentId = tournamentIdFromUrl(listUrl);
  const fullPages = await discoverTournamentDayPages(listUrl);
  let added = 0;
  for (const p of fullPages) {
    if (state.categories[p.url]) continue; // já tínhamos essa página
    ingestPage(p, listUrl, tournamentId);
    added += 1;
  }
  scheduleSave();
  return { added, totalPages: fullPages.length };
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
          team: occ.team || null,
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

// Busca por academia/equipe (ex.: "Inspirit") em vez de por nome de atleta
// — mais confiável quando não se sabe o roster de cor, ou pra pegar atleta
// que ainda não está cadastrado. Substring, acento/case-insensitive.
function searchByTeam(query, { limit = 200 } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const seen = new Map(); // `${name}|${categoryUrl}` -> occurrence
  for (const occ of lastScan.occurrences || []) {
    if (!occ.team) continue;
    if (!normalize(occ.team).includes(q)) continue;
    const key = `${occ.name}|${occ.categoryUrl}`;
    if (!seen.has(key)) seen.set(key, occ);
  }
  return [...seen.values()].slice(0, limit);
}

// Adiciona (ou reaproveita, se já existir no roster) um atleta achado pela
// busca por academia, e já confirma o mapeamento pra categoria/tatame onde
// ele apareceu — um clique só em vez de "adicionar no roster" + "confirmar
// no scan" separados.
function addFromTeamSearch({ name, categoryUrl, categoryName, tournamentUrl, tournamentId, siteName, day, event, baseMat }) {
  const normalized = normalize(name);
  let athlete = state.roster.find((a) => normalize(a.name) === normalized);
  if (!athlete) {
    athlete = addRosterEntry({ name, day, event, baseMat: baseMat || null, baseTime: null });
  }
  const mapping = confirmMapping(athlete.id, {
    categoryUrl,
    categoryName,
    tournamentUrl,
    tournamentId,
    siteName: siteName || name,
  });
  return { athlete, mapping };
}

module.exports = {
  scanTournaments,
  fullScanTournament,
  suggestMappings,
  confirmMapping,
  clearMapping,
  getLastScan,
  searchByTeam,
  addFromTeamSearch,
};

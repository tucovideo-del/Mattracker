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
  pageNumberFromUrl,
  fetchTournamentDayPage,
  discoverTournamentDayPages,
  matPageMapFromPages,
} = require('./scraper');
const { findCandidates, normalize } = require('./match');
const { state, scheduleSave, addRosterEntry } = require('./store');
const { TOURNAMENT_SOURCES } = require('./tournament-sources-default');

const LABEL_BY_TOURNAMENT_ID = new Map(
  TOURNAMENT_SOURCES.map((t) => [tournamentIdFromUrl(t.url), t.label]).filter(([id]) => id)
);

// tatame->página CONFIRMADO na mão pra torneios específicos (ver comentário
// em tournament-sources-default.js) — chave é a URL exata, não o id, pra
// não vazar pra outro dia do mesmo torneio sem confirmação própria.
const MAT_PAGE_OFFSET_BY_URL = new Map(
  TOURNAMENT_SOURCES.filter((t) => t.matPageOffset != null).map((t) => [t.url, t.matPageOffset])
);

// Um atleta pode competir em mais de um torneio (ex.: Gi E NoGi do mesmo
// evento) — cada um vira um occurrence separado, então sem isso os
// candidatos de AMBOS aparecem misturados pra cada entrada do roster,
// mesmo a errada. Usa o rótulo do torneio (event/modality já conhecidos
// no roster) pra desempatar: candidato do torneio certo sobe, do torneio
// errado desce — mas nunca some, o operador ainda pode escolher na mão.
function tournamentLabelMatchesAthlete(label, athlete) {
  if (!label) return null; // sem rótulo (torneio não catalogado) — neutro
  const l = label.toLowerCase();
  const isNoGiLabel = /nogi|no-gi|no gi/.test(l);
  const isKidsLabel = /kid/.test(l);
  const isMasterLabel = /master/.test(l);
  const isConLabel = /\bcon\b/.test(l) && !isKidsLabel;

  if (athlete.event === 'WM') return isMasterLabel;
  if (athlete.event === 'KIDS') {
    if (!isKidsLabel) return false;
    if (athlete.modality === 'NOGI') return isNoGiLabel;
    if (athlete.modality === 'GI') return !isNoGiLabel;
    return true;
  }
  if (athlete.event === 'CON') {
    if (!isConLabel) return false;
    if (athlete.modality === 'NOGI') return isNoGiLabel;
    if (athlete.modality === 'GI') return !isNoGiLabel;
    return true;
  }
  return null;
}

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

// bjjcompsystem.com pagina cada tournament_day por TATAME (?page=N). A
// relação entre número da página e número do tatame NÃO é confiável de
// adivinhar (confirmado ao vivo: page=1 mostrou Mat 10 e page=3 mostrou
// Mat 9 no mesmo torneio — o número do tatame pode até CAIR conforme a
// página sobe) — mas UMA VEZ que a gente varreu de verdade e sabe o mapa
// real tatame->página daquela URL, não tem por que repetir a varredura
// completa nas próximas vezes: cacheia em state.matPageIndex[url] (dado
// observado, não fórmula adivinhada) e pula direto pras páginas conhecidas.
// Só faz a varredura completa (discoverTournamentDayPages, mais lenta) na
// primeira vez que vê essa URL, ou quando o operador força via "Busca
// completa" (fullScanTournament, que sempre atualiza o cache).
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
            const cachedIndex = state.matPageIndex[listUrl];
            let discovered;

            if (cachedIndex && Object.keys(cachedIndex).length > 0) {
              const pageNums = [...new Set(Object.values(cachedIndex))];
              discovered = (
                await Promise.all(pageNums.map((page) => fetchTournamentDayPage(listUrl, page).catch(() => null)))
              ).filter(Boolean);
            } else if (MAT_PAGE_OFFSET_BY_URL.has(listUrl)) {
              // sem cache ainda, mas alguém já confirmou na mão a relação
              // tatame->página desse torneio — vai direto nos tatames que
              // o roster espera em vez de recorrer à varredura completa.
              const offset = MAT_PAGE_OFFSET_BY_URL.get(listUrl);
              const wantedMats = [...new Set(state.roster.map((a) => parseInt(a.baseMat, 10)).filter(Number.isFinite))];
              discovered = (
                await Promise.all(
                  wantedMats
                    .filter((mat) => mat - offset >= 1)
                    .map(async (mat) => {
                      const result = await fetchTournamentDayPage(listUrl, mat - offset).catch(() => null);
                      if (!result) return null;
                      // confia no tatame calculado (confirmado na mão) mesmo
                      // se a página não repetir "Mat N" em texto nenhum
                      // (ex.: chave já toda decidida, sem "Winner of Fight"
                      // sobrando pra gente extrair o número de outro jeito).
                      return { ...result, mat: result.mat != null ? result.mat : String(mat) };
                    })
                )
              ).filter(Boolean);
              if (discovered.length > 0) {
                state.matPageIndex[listUrl] = matPageMapFromPages(discovered);
              } else {
                // nem o atalho confirmado achou nada — pode ser o site fora
                // do ar, ou a relação mudou; cai pra varredura completa em
                // vez de desistir em silêncio.
                discovered = await discoverTournamentDayPages(listUrl);
                state.matPageIndex[listUrl] = matPageMapFromPages(discovered);
              }
            } else {
              discovered = await discoverTournamentDayPages(listUrl);
              state.matPageIndex[listUrl] = matPageMapFromPages(discovered);
            }
            const pages = new Map(discovered.map((p) => [p.url, p]));
            const firstReal = discovered.find((p) => p.mat != null);
            tournaments.push({ tournamentId, sourceUrl: listUrl, categoriesCount: pages.size });
            dayTournaments.push({ sourceUrl: listUrl, tournamentId, firstMat: firstReal ? firstReal.mat : null, pages });
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

  // Diagnóstico completo de cada torneio: qual tatame a page=1 revelou,
  // e o que cada página realmente trouxe (tatame detectado, quantas lutas
  // e atletas) — pra conferir de uma vez se o "pulo" calculado caiu numa
  // página com gente de verdade ou foi parar em outro lugar.
  const diagnostics = dayTournaments.map((dt) => ({
    sourceUrl: dt.sourceUrl,
    tournamentId: dt.tournamentId,
    firstMat: dt.firstMat,
    pages: [...dt.pages.values()]
      .map((p) => ({
        page: pageNumberFromUrl(p.url),
        url: p.url,
        mat: p.mat,
        fights: p.fights.length,
        athletes: p.fights.reduce((sum, f) => sum + f.athletes.length, 0),
        sampleAthletes: p.fights.slice(0, 6).map((f) => f.athletes.join(' vs ')),
      }))
      .sort((a, b) => (a.page || 0) - (b.page || 0)),
  }));

  return {
    tournaments,
    categoriesScanned: lastScan.categories.length,
    errors,
    tournamentDaysScanned: dayTournaments.map((dt) => dt.sourceUrl),
    diagnostics,
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
  state.matPageIndex[listUrl] = matPageMapFromPages(fullPages); // atualiza o cache com o que achou de novo
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
        const tournamentLabel = LABEL_BY_TOURNAMENT_ID.get(occ.tournamentId) || null;
        byCategory.set(occ.categoryUrl, {
          categoryUrl: occ.categoryUrl,
          categoryName: occ.categoryName,
          tournamentUrl: occ.tournamentUrl,
          tournamentId: occ.tournamentId,
          tournamentLabel,
          tournamentMatch: tournamentLabelMatchesAthlete(tournamentLabel, athlete),
          siteName: occ.name,
          team: occ.team || null,
          score: score[0].score,
        });
      }
    }
    // atleta que compete em mais de um torneio (ex.: Gi e NoGi do mesmo
    // evento) aparece com candidatos de AMBOS — prioriza o do torneio
    // certo pro roster (tournamentMatch true > desconhecido > errado),
    // e só desempata por score dentro do mesmo grupo.
    const matchRank = (c) => (c.tournamentMatch === true ? 0 : c.tournamentMatch === null ? 1 : 2);
    const candidates = [...byCategory.values()]
      .sort((a, b) => matchRank(a) - matchRank(b) || b.score - a.score)
      .slice(0, 5);
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

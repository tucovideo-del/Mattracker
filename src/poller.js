'use strict';

// Polling em background: busca só as categorias que têm pelo menos um
// atleta monitorado mapeado (nunca varre o site inteiro). Tolerante a
// falha de rede por categoria — mantém o último estado bom + timestamp.

const { fetchCategoryFights } = require('./scraper');
const { state, scheduleSave, addLogEntry } = require('./store');

const MIN_INTERVAL_MS = 45000;
const MAX_INTERVAL_MS = 60000;

function mappedCategoryUrls() {
  const urls = new Set();
  for (const m of Object.values(state.mappings)) {
    if (m && m.confirmed && m.categoryUrl) urls.add(m.categoryUrl);
  }
  return [...urls];
}

function athletesForCategory(categoryUrl) {
  return Object.entries(state.mappings)
    .filter(([, m]) => m && m.confirmed && m.categoryUrl === categoryUrl)
    .map(([athleteId, m]) => ({ athleteId, siteName: m.siteName }));
}

function logNewResults(categoryUrl, prevFights, newFights) {
  const prevByNum = new Map((prevFights || []).map((f) => [f.fightNumber, f]));
  const athletes = athletesForCategory(categoryUrl);
  if (athletes.length === 0) return;

  for (const fight of newFights) {
    if (fight.status !== 'done' || !fight.winner) continue;
    const prev = prevByNum.get(fight.fightNumber);
    if (prev && prev.status === 'done' && prev.winner === fight.winner) continue; // já registrado

    for (const { athleteId, siteName } of athletes) {
      const involved = fight.athletes.some(
        (a) => a.toLowerCase() === String(siteName).toLowerCase()
      );
      if (!involved) continue;
      const roster = state.roster.find((r) => r.id === athleteId);
      const won = fight.winner.toLowerCase() === String(siteName).toLowerCase();
      addLogEntry({
        athleteId,
        athleteName: roster ? roster.name : siteName,
        fightNumber: fight.fightNumber,
        mat: fight.mat,
        result: won ? 'W' : 'L',
        winner: fight.winner,
        opponents: fight.athletes.filter((a) => a.toLowerCase() !== String(siteName).toLowerCase()),
      });
    }
  }
}

async function pollCategory(categoryUrl) {
  const prev = state.categories[categoryUrl];
  try {
    const result = await fetchCategoryFights(categoryUrl);
    logNewResults(categoryUrl, prev && prev.fights, result.fights);
    state.categories[categoryUrl] = {
      categoryName: result.categoryName || (prev && prev.categoryName) || null,
      fights: result.fights,
      fetchedAt: result.fetchedAt,
      lastError: null,
      lastErrorAt: null,
    };
    return { categoryUrl, ok: true };
  } catch (err) {
    state.categories[categoryUrl] = {
      categoryName: prev ? prev.categoryName : null,
      fights: prev ? prev.fights : [],
      fetchedAt: prev ? prev.fetchedAt : null,
      lastError: err.message,
      lastErrorAt: new Date().toISOString(),
    };
    return { categoryUrl, ok: false, error: err.message };
  }
}

async function pollOnce() {
  const urls = mappedCategoryUrls();
  const results = await Promise.all(urls.map(pollCategory));
  state.lastPollAt = new Date().toISOString();
  state.lastPollOk = results.every((r) => r.ok);
  state.lastPollErrors = results.filter((r) => !r.ok).map((r) => ({ categoryUrl: r.categoryUrl, error: r.error }));
  scheduleSave();
  return results;
}

let timer = null;
function scheduleNext() {
  const delay = MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
  timer = setTimeout(async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[poller] erro inesperado no ciclo de polling:', err);
    }
    scheduleNext();
  }, delay);
}

function startPolling() {
  if (timer) return;
  // primeira rodada quase imediata pra não deixar o painel vazio
  setTimeout(() => {
    pollOnce()
      .catch((err) => console.error('[poller] erro no primeiro poll:', err))
      .finally(scheduleNext);
  }, 500);
}

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { startPolling, stopPolling, pollOnce, mappedCategoryUrls };

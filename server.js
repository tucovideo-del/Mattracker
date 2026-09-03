'use strict';

const path = require('path');
const express = require('express');

const { buildBoard } = require('./src/board');
const { listRosterWithMappingInfo } = require('./src/board-list');
const {
  scanTournaments,
  fullScanTournament,
  suggestMappings,
  confirmMapping,
  clearMapping,
  getLastScan,
  searchByTeam,
  addFromTeamSearch,
} = require('./src/setup');
const { pollOnce, mappedCategoryUrls } = require('./src/poller');
const { startPolling } = require('./src/poller');
const { state, toggleCovered, addRosterEntry, updateRosterEntry, removeRosterEntry } = require('./src/store');
const { fetchCategoryFights, fetchCategoriesList } = require('./src/scraper');
const { DAY_LABELS, EVENT_LABELS } = require('./src/roster-default');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

app.get('/api/status', (req, res) => {
  const { day, event } = req.query;
  res.json(buildBoard({ day: day || null, event: event || null }));
});

app.post(
  '/api/refresh',
  asyncHandler(async (req, res) => {
    const results = await pollOnce();
    res.json({ results, board: buildBoard({}) });
  })
);

app.get('/api/meta', (req, res) => {
  res.json({ dayLabels: DAY_LABELS, eventLabels: EVENT_LABELS, mappedCategoryUrls: mappedCategoryUrls() });
});

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

app.get('/api/roster', (req, res) => {
  res.json(listRosterWithMappingInfo());
});

app.post('/api/roster', (req, res) => {
  try {
    const entry = addRosterEntry(req.body || {});
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/roster/:id', (req, res) => {
  try {
    const entry = updateRosterEntry(req.params.id, req.body || {});
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/roster/:id', (req, res) => {
  try {
    removeRosterEntry(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Setup (scan + confirmação de mapeamento)
// ---------------------------------------------------------------------------

app.post(
  '/api/setup/scan',
  asyncHandler(async (req, res) => {
    const urls = req.body && req.body.tournamentUrls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'tournamentUrls (array) é obrigatório' });
    }
    const scanResult = await scanTournaments(urls);
    res.json({ ...scanResult, suggestions: suggestMappings() });
  })
);

app.get('/api/setup/suggestions', (req, res) => {
  res.json(suggestMappings());
});

// Plano B: quando a busca rápida (scan) não achou um atleta, varre TODAS
// as páginas (tatames) daquele tournament_day em vez de só pular pro
// tatame-base esperado. Mais lento, mas cobre atleta que mudou de tatame.
app.post(
  '/api/setup/full-scan',
  asyncHandler(async (req, res) => {
    const tournamentUrl = req.body && req.body.tournamentUrl;
    if (!tournamentUrl) return res.status(400).json({ error: 'tournamentUrl é obrigatório' });
    const result = await fullScanTournament(tournamentUrl);
    res.json({ ...result, suggestions: suggestMappings() });
  })
);

app.get('/api/setup/categories', (req, res) => {
  res.json(getLastScan());
});

// Busca por academia (ex.: "Inspirit") entre tudo que já foi escaneado —
// mais confiável que tentar acertar nomes de atleta um por um.
app.get('/api/setup/team-search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'query param q é obrigatório' });
  res.json(searchByTeam(String(q)));
});

app.post('/api/setup/team-search/add', (req, res) => {
  const { name, categoryUrl, categoryName, tournamentUrl, tournamentId, siteName, day, event, baseMat } = req.body || {};
  if (!name || !categoryUrl || !day || !event) {
    return res.status(400).json({ error: 'name, categoryUrl, day e event são obrigatórios' });
  }
  try {
    const result = addFromTeamSearch({ name, categoryUrl, categoryName, tournamentUrl, tournamentId, siteName, day, event, baseMat });
    res.json({ ...result, suggestions: suggestMappings() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post(
  '/api/setup/confirm',
  asyncHandler(async (req, res) => {
    const mappings = req.body && req.body.mappings;
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({ error: 'mappings (array) é obrigatório' });
    }
    const errors = [];
    for (const m of mappings) {
      try {
        confirmMapping(m.athleteId, m);
      } catch (err) {
        errors.push({ athleteId: m.athleteId, error: err.message });
      }
    }
    const results = await pollOnce();
    res.json({ errors, pollResults: results, board: buildBoard({}) });
  })
);

app.delete('/api/setup/mapping/:athleteId', (req, res) => {
  clearMapping(req.params.athleteId);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Shooter mode + log
// ---------------------------------------------------------------------------

app.post('/api/covered', (req, res) => {
  const { athleteId, fightNumber } = req.body || {};
  if (!athleteId || fightNumber == null) {
    return res.status(400).json({ error: 'athleteId e fightNumber são obrigatórios' });
  }
  const covered = toggleCovered(athleteId, fightNumber);
  res.json({ athleteId, fightNumber, covered });
});

app.get('/api/log', (req, res) => {
  res.json(state.log);
});

// ---------------------------------------------------------------------------
// Debug / calibração do parser (ver README) — não usa cache, busca ao vivo.
// ---------------------------------------------------------------------------

app.get(
  '/api/debug/category',
  asyncHandler(async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'query param url é obrigatório' });
    const result = await fetchCategoryFights(url);
    res.json(result);
  })
);

app.get(
  '/api/debug/tournament',
  asyncHandler(async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'query param url é obrigatório' });
    const result = await fetchCategoriesList(url);
    res.json(result);
  })
);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[server] erro:', err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mat Tracker rodando em http://0.0.0.0:${PORT}`);
  startPolling();
});

'use strict';

// Estado da aplicação, tudo em memória + persistido em data/state.json pra
// sobreviver a um restart do processo (o notebook do Tuco pode reiniciar o
// app no meio do evento). Um app de uma pessoa só, então sem cuidados de
// concorrência além do básico.

const fs = require('fs');
const path = require('path');
const { ROSTER } = require('./roster-default');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function defaultState() {
  return {
    roster: ROSTER,
    // athleteId -> { tournamentUrl, tournamentId, categoryUrl, categoryName, siteName, confirmed }
    mappings: {},
    // categoryUrl -> { categoryName, fights: [], fetchedAt, lastError, lastErrorAt }
    categories: {},
    // `${athleteId}:${fightNumber}` -> true
    covered: {},
    log: [],
    lastPollAt: null,
    lastPollOk: null,
    lastPollErrors: [],
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // merge com defaults pra tolerar campos novos em versões futuras
      return { ...defaultState(), ...parsed };
    }
  } catch (err) {
    console.error('[store] falha ao carregar state.json, iniciando do zero:', err.message);
  }
  return defaultState();
}

const state = loadState();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[store] falha ao salvar state.json:', err.message);
    }
  }, 400);
}

function addLogEntry(entry) {
  state.log.push({ ...entry, timestamp: new Date().toISOString() });
  if (state.log.length > 5000) state.log.splice(0, state.log.length - 5000);
  scheduleSave();
}

function toggleCovered(athleteId, fightNumber) {
  const key = `${athleteId}:${fightNumber}`;
  state.covered[key] = !state.covered[key];
  scheduleSave();
  return state.covered[key];
}

function isCovered(athleteId, fightNumber) {
  return !!state.covered[`${athleteId}:${fightNumber}`];
}

let _nextRosterNum = state.roster.reduce((max, r) => {
  const m = /^a(\d+)$/.exec(r.id);
  return m ? Math.max(max, parseInt(m[1], 10)) : max;
}, 0);

function addRosterEntry({ name, day, event, modality, baseTime, baseMat }) {
  if (!name || !day || !event) throw new Error('name, day e event são obrigatórios');
  _nextRosterNum += 1;
  const entry = {
    id: `a${_nextRosterNum}`,
    name,
    day,
    event,
    modality: modality || null,
    baseTime: baseTime || null,
    baseMinutesGuess: null,
    baseMat: baseMat != null ? String(baseMat) : null,
  };
  state.roster.push(entry);
  scheduleSave();
  return entry;
}

function updateRosterEntry(id, patch) {
  const entry = state.roster.find((r) => r.id === id);
  if (!entry) throw new Error(`atleta desconhecido: ${id}`);
  for (const key of ['name', 'day', 'event', 'modality', 'baseTime', 'baseMat']) {
    if (patch[key] !== undefined) entry[key] = patch[key];
  }
  scheduleSave();
  return entry;
}

function removeRosterEntry(id) {
  const idx = state.roster.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error(`atleta desconhecido: ${id}`);
  state.roster.splice(idx, 1);
  delete state.mappings[id];
  for (const key of Object.keys(state.covered)) {
    if (key.startsWith(`${id}:`)) delete state.covered[key];
  }
  scheduleSave();
}

module.exports = {
  state,
  scheduleSave,
  addLogEntry,
  toggleCovered,
  isCovered,
  addRosterEntry,
  updateRosterEntry,
  removeRosterEntry,
  STATE_FILE,
};

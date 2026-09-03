'use strict';

const state = {
  day: null,
  event: null,
  dayLabels: {},
  eventLabels: {},
  soundEnabled: localStorage.getItem('mt_sound') === '1',
  alerted: new Set(), // `${athleteId}:${fightNumber}` já alertados nesta sessão
  lastPollAt: null,
  lastPollOk: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Meta / filtros
// ---------------------------------------------------------------------------

async function loadMeta() {
  const meta = await api('/api/meta');
  state.dayLabels = meta.dayLabels;
  state.eventLabels = meta.eventLabels;
  renderFilters();
}

function renderFilters() {
  const dayEl = $('#dayFilters');
  const eventEl = $('#eventFilters');
  dayEl.innerHTML = '';
  eventEl.innerHTML = '';

  const dayAll = chip('Todos', state.day === null, () => setDay(null));
  dayEl.appendChild(dayAll);
  for (const [code, label] of Object.entries(state.dayLabels)) {
    dayEl.appendChild(chip(label, state.day === code, () => setDay(code)));
  }

  const eventAll = chip('Todos', state.event === null, () => setEvent(null));
  eventEl.appendChild(eventAll);
  for (const [code, label] of Object.entries(state.eventLabels)) {
    eventEl.appendChild(chip(label, state.event === code, () => setEvent(code)));
  }
}

function chip(label, selected, onClick) {
  const btn = document.createElement('button');
  btn.className = 'chip' + (selected ? ' selected' : '');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function setDay(day) {
  state.day = day;
  renderFilters();
  loadStatus();
}

function setEvent(event) {
  state.event = event;
  renderFilters();
  loadStatus();
}

// ---------------------------------------------------------------------------
// Painel (status)
// ---------------------------------------------------------------------------

async function loadStatus() {
  const params = new URLSearchParams();
  if (state.day) params.set('day', state.day);
  if (state.event) params.set('event', state.event);
  try {
    const board = await api(`/api/status?${params.toString()}`);
    state.lastPollAt = board.lastPollAt;
    state.lastPollOk = board.lastPollOk;
    state.lastPollErrors = board.lastPollErrors;
    renderBoard(board);
    checkSoundAlerts(board.active);
  } catch (err) {
    $('#freshness').textContent = `Erro ao buscar status: ${err.message}`;
    $('#freshness').className = 'error';
  }
}

function fmtOpponents(opponents) {
  if (!opponents || opponents.length === 0) return '';
  return opponents.join(', ');
}

function urgencyMeta(urgency) {
  if (urgency === 'now') return { dot: '🔴', label: 'AGORA', cls: 'urgency-now' };
  if (urgency === 'soon') return { dot: '🟡', label: 'EM BREVE', cls: 'urgency-soon' };
  return { dot: '⚪', label: '', cls: 'urgency-later' };
}

function badgeHtml(entry) {
  if (entry.badge === 'lutou') {
    const cls = entry.lastResult === 'W' ? 'badge-lutou-w' : 'badge-lutou-l';
    return `<span class="badge ${cls}">Lutou (${entry.lastResult || '?'})</span>`;
  }
  if (entry.badge === 'na_fila') return `<span class="badge badge-na_fila">Na fila</span>`;
  if (entry.badge === 'eliminado') return `<span class="badge badge-eliminado">Eliminado</span>`;
  if (entry.badge === 'campeao') return `<span class="badge badge-campeao">🏆 Campeão</span>`;
  return `<span class="badge badge-aguardando">Aguardando</span>`;
}

function renderActiveCard(entry) {
  const li = document.createElement('li');
  const u = urgencyMeta(entry.urgency);
  li.className = `fight-card ${u.cls}` + (entry.conflict ? ' conflict' : '');

  const nf = entry.nextFight;
  const timeStr = nf ? (nf.scheduledTime || 'TBD') : '';
  const queueStr = nf && nf.queuePosition != null
    ? (nf.queuePosition === 0 ? 'próxima no tatame' : `${nf.queuePosition} luta(s) na frente`)
    : '';

  li.innerHTML = `
    <div class="fight-top">
      <span class="urgency-dot">${u.dot}</span>
      <span class="mat-tag">MAT ${nf && nf.mat ? nf.mat : '?'}</span>
      <span class="fight-time">${timeStr}</span>
    </div>
    <div class="athlete-name">${escapeHtml(entry.name)}</div>
    <div class="fight-meta">
      ${badgeHtml(entry)}
      <span>${escapeHtml(entry.categoryName || entry.event)}</span>
      ${nf && nf.opponents.length ? `<span>vs ${escapeHtml(fmtOpponents(nf.opponents))}</span>` : ''}
      ${queueStr ? `<span>${queueStr}</span>` : ''}
      ${nf && nf.bye ? '<span>BYE</span>' : ''}
    </div>
    <div class="card-actions">
      <button class="cover-btn ${nf && nf.covered ? 'covered' : ''}" data-athlete="${entry.athleteId}" data-fight="${nf ? nf.fightNumber : ''}">
        ${nf && nf.covered ? '✅ Cobri esta luta' : '📸 Marcar cobertura'}
      </button>
    </div>
  `;

  const coverBtn = li.querySelector('.cover-btn');
  if (nf) {
    coverBtn.addEventListener('click', async () => {
      await api('/api/covered', {
        method: 'POST',
        body: JSON.stringify({ athleteId: entry.athleteId, fightNumber: nf.fightNumber }),
      });
      loadStatus();
    });
  } else {
    coverBtn.disabled = true;
  }

  return li;
}

function renderWaitingRow(entry) {
  const li = document.createElement('li');
  li.className = 'fight-card';
  li.innerHTML = `
    <div class="fight-top">
      <span class="urgency-dot">⚪</span>
      <span class="mat-tag">Base: MAT ${entry.baseMat || '?'}</span>
      <span class="fight-time">${entry.baseTime || ''}</span>
    </div>
    <div class="athlete-name">${escapeHtml(entry.name)}</div>
    <div class="fight-meta">
      ${badgeHtml(entry)}
      <span>${escapeHtml(entry.event)} · ${escapeHtml(state.dayLabels[entry.day] || entry.day)}</span>
      ${!entry.mapped ? '<span>não mapeado — vá em Setup</span>' : '<span>bracket ainda sem próxima luta</span>'}
    </div>
  `;
  return li;
}

function renderFinishedRow(entry) {
  const li = document.createElement('li');
  li.className = 'fight-card';
  li.innerHTML = `
    <div class="athlete-name">${escapeHtml(entry.name)}</div>
    <div class="fight-meta">
      ${badgeHtml(entry)}
      <span>${escapeHtml(entry.categoryName || entry.event)}</span>
      ${entry.note ? `<span>${escapeHtml(entry.note)}</span>` : ''}
    </div>
  `;
  return li;
}

function renderBoard(board) {
  const activeList = $('#activeList');
  activeList.innerHTML = '';
  for (const e of board.active) activeList.appendChild(renderActiveCard(e));
  $('#emptyActive').hidden = board.active.length > 0;

  const waitingList = $('#waitingList');
  waitingList.innerHTML = '';
  for (const e of board.waiting) waitingList.appendChild(renderWaitingRow(e));
  $('#waitingCount').textContent = board.waiting.length;

  const finishedList = $('#finishedList');
  finishedList.innerHTML = '';
  for (const e of board.finished) finishedList.appendChild(renderFinishedRow(e));
  $('#finishedCount').textContent = board.finished.length;

  renderConflicts(board.conflicts, board.active);
  updateFreshness();
}

function renderConflicts(conflicts, active) {
  const el = $('#conflictBanner');
  if (!conflicts || conflicts.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const byId = new Map(active.map((e) => [e.athleteId, e]));
  el.hidden = false;
  el.innerHTML = `<strong>⚠️ Conflito de horário</strong>` + conflicts
    .map((c) => {
      const names = c.athleteIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((e) => `${escapeHtml(e.name)} (MAT ${e.nextFight ? e.nextFight.mat : '?'} · ${e.nextFight ? e.nextFight.scheduledTime : ''})`)
        .join(' × ');
      const distStr = c.matDistance != null ? ` · ${c.matDistance} tatames de distância` : '';
      return `<div class="conflict-pair">${names} — ~${c.gapMinutes}min de diferença${distStr}</div>`;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// Freshness ticker
// ---------------------------------------------------------------------------

function updateFreshness() {
  const el = $('#freshness');
  if (!state.lastPollAt) {
    el.textContent = 'Ainda sem dados — configure o Setup';
    el.className = '';
    return;
  }
  const secs = Math.max(0, Math.round((Date.now() - new Date(state.lastPollAt).getTime()) / 1000));
  const label = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}min`;
  const errCount = (state.lastPollErrors || []).length;
  if (!state.lastPollOk && errCount > 0) {
    el.textContent = `atualizado há ${label} · ${errCount} categoria(s) com erro`;
    el.className = 'error';
  } else if (secs > 90) {
    el.textContent = `atualizado há ${label} (verifique a conexão)`;
    el.className = 'stale';
  } else {
    el.textContent = `atualizado há ${label}`;
    el.className = '';
  }
}

setInterval(updateFreshness, 1000);

// ---------------------------------------------------------------------------
// Alerta sonoro / vibração
// ---------------------------------------------------------------------------

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch { /* ambiente sem audio, ignora */ }
}

function checkSoundAlerts(active) {
  if (!state.soundEnabled) return;
  for (const e of active) {
    if (!e.nextFight || e.nextFight.queuePosition == null) continue;
    if (e.nextFight.queuePosition > 2) continue;
    const key = `${e.athleteId}:${e.nextFight.fightNumber}`;
    if (state.alerted.has(key)) continue;
    state.alerted.add(key);
    beep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
}

$('#soundToggle').addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem('mt_sound', state.soundEnabled ? '1' : '0');
  $('#soundToggle').textContent = state.soundEnabled ? '🔔' : '🔕';
  $('#soundToggle').classList.toggle('active', state.soundEnabled);
  if (state.soundEnabled) beep(); // feedback + desbloqueia audio no iOS/Safari
});
if (state.soundEnabled) {
  $('#soundToggle').textContent = '🔔';
  $('#soundToggle').classList.add('active');
}

// ---------------------------------------------------------------------------
// Collapsibles
// ---------------------------------------------------------------------------

$$('.collapsible-header').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    target.classList.toggle('collapsed');
    btn.classList.toggle('open');
  });
});

// ---------------------------------------------------------------------------
// Refresh manual
// ---------------------------------------------------------------------------

$('#refreshBtn').addEventListener('click', async () => {
  $('#refreshBtn').textContent = '…';
  try {
    await api('/api/refresh', { method: 'POST' });
  } catch { /* mesmo com erro de rede, recarrega o status com o que tiver */ }
  await loadStatus();
  $('#refreshBtn').textContent = '↻ Atualizar';
});

// ---------------------------------------------------------------------------
// Setup overlay
// ---------------------------------------------------------------------------

let lastSuggestions = [];

$('#setupBtn').addEventListener('click', () => {
  $('#setupOverlay').hidden = false;
  loadRosterMgmt();
});
$('#closeSetup').addEventListener('click', () => {
  $('#setupOverlay').hidden = true;
  loadStatus();
});

let lastTournamentDaysScanned = [];

$('#scanBtn').addEventListener('click', async () => {
  const raw = $('#tournamentUrls').value.trim();
  const urls = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) return;
  $('#scanStatus').textContent = 'Pulando direto pro tatame esperado de cada atleta…';
  $('#scanBtn').disabled = true;
  try {
    const result = await api('/api/setup/scan', {
      method: 'POST',
      body: JSON.stringify({ tournamentUrls: urls }),
    });
    lastSuggestions = result.suggestions;
    lastTournamentDaysScanned = result.tournamentDaysScanned || [];
    const unmatched = lastSuggestions.filter((s) => s.candidates.length === 0).length;
    $('#scanStatus').textContent =
      `${result.categoriesScanned} página(s) escaneada(s), ${unmatched} atleta(s) sem candidato ainda.` +
      (result.errors.length ? ` ${result.errors.length} erro(s) — veja o console.` : '');
    if (result.errors.length) console.warn('Erros no scan:', result.errors);
    renderSuggestions(lastSuggestions);
    renderFullScanControls(unmatched);
    $('#suggestionsSection').hidden = false;
  } catch (err) {
    $('#scanStatus').textContent = `Erro: ${err.message}`;
  } finally {
    $('#scanBtn').disabled = false;
  }
});

function renderFullScanControls(unmatchedCount) {
  const el = $('#fullScanControls');
  el.innerHTML = '';
  if (unmatchedCount === 0 || lastTournamentDaysScanned.length === 0) return;
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = `Tem atleta sem candidato — pode ser tatame reatribuído. Busca completa (mais lenta) varre TODOS os tatames de um torneio:`;
  el.appendChild(hint);
  for (const url of lastTournamentDaysScanned) {
    const btn = document.createElement('button');
    btn.className = 'secondary-btn';
    btn.textContent = `Busca completa — ${url}`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Varrendo todos os tatames…';
      try {
        const result = await api('/api/setup/full-scan', {
          method: 'POST',
          body: JSON.stringify({ tournamentUrl: url }),
        });
        lastSuggestions = result.suggestions;
        const stillUnmatched = lastSuggestions.filter((s) => s.candidates.length === 0).length;
        $('#scanStatus').textContent = `Busca completa: +${result.added} tatame(s) novo(s) de ${result.totalPages}. ${stillUnmatched} atleta(s) ainda sem candidato.`;
        renderSuggestions(lastSuggestions);
        renderFullScanControls(stillUnmatched);
      } catch (err) {
        btn.textContent = `Erro: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });
    el.appendChild(btn);
  }
}

function renderSuggestions(suggestions) {
  const el = $('#suggestionsList');
  el.innerHTML = '';
  for (const s of suggestions) {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    const options = [...s.candidates];
    let optionsHtml = options
      .map((c, i) => {
        const low = c.score < 0.85 ? ' low-confidence' : '';
        const checked = i === 0 && c.score >= 0.85 ? 'checked' : '';
        const teamStr = c.team ? ` · ${escapeHtml(c.team)}` : '';
        return `
          <div class="candidate-option${low}">
            <input type="radio" name="pick-${s.athleteId}" id="opt-${s.athleteId}-${i}" value="${i}" ${checked} />
            <label for="opt-${s.athleteId}-${i}">
              <span class="candidate-name">${escapeHtml(c.siteName)}</span>
              <span class="candidate-meta">${escapeHtml(c.categoryName || '')}${teamStr} <span class="score-tag">(${Math.round(c.score * 100)}%)</span></span>
            </label>
          </div>`;
      })
      .join('');
    const currentTag = s.currentMapping
      ? `<span class="score-tag">já mapeado: ${escapeHtml(s.currentMapping.siteName)} — ${escapeHtml(s.currentMapping.categoryName || '')}</span>`
      : '';
    optionsHtml += `
      <div class="candidate-option">
        <input type="radio" name="pick-${s.athleteId}" id="opt-${s.athleteId}-none" value="none" ${options.length === 0 ? 'checked' : ''} />
        <label for="opt-${s.athleteId}-none"><span class="candidate-name">Não mapear agora</span></label>
      </div>`;

    card.innerHTML = `
      <div class="suggestion-name">${escapeHtml(s.name)}</div>
      <div class="suggestion-sub">${escapeHtml(state.eventLabels[s.event] || s.event)} · ${escapeHtml(state.dayLabels[s.day] || s.day)} ${currentTag}</div>
      ${optionsHtml}
    `;
    card.dataset.athleteId = s.athleteId;
    el.appendChild(card);
  }
}

$('#confirmBtn').addEventListener('click', async () => {
  const mappings = [];
  for (const card of $$('.suggestion-card')) {
    const athleteId = card.dataset.athleteId;
    const suggestion = lastSuggestions.find((s) => s.athleteId === athleteId);
    if (!suggestion) continue;
    const picked = card.querySelector('input[type=radio]:checked');
    if (!picked || picked.value === 'none') continue;
    const candidate = suggestion.candidates[parseInt(picked.value, 10)];
    if (!candidate) continue;
    mappings.push({ athleteId, ...candidate });
  }
  if (mappings.length === 0) {
    $('#confirmStatus').textContent = 'Nenhum atleta selecionado.';
    return;
  }
  $('#confirmBtn').disabled = true;
  $('#confirmStatus').textContent = 'Salvando e buscando dados iniciais…';
  try {
    await api('/api/setup/confirm', { method: 'POST', body: JSON.stringify({ mappings }) });
    $('#confirmStatus').textContent = `${mappings.length} atleta(s) mapeado(s) com sucesso.`;
    loadRosterMgmt();
    loadStatus();
  } catch (err) {
    $('#confirmStatus').textContent = `Erro: ${err.message}`;
  } finally {
    $('#confirmBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Busca por academia (ex.: Inspirit) — mais confiável que adivinhar nomes
// um por um, e acha atleta que ainda nem está no roster.
// ---------------------------------------------------------------------------

function guessEventFromCategoryName(name) {
  const n = (name || '').toLowerCase();
  if (/kid/.test(n)) return 'KIDS';
  if (/master/.test(n)) return 'WM';
  return 'CON';
}

$('#teamSearchBtn').addEventListener('click', async () => {
  const q = $('#teamSearchInput').value.trim();
  if (!q) return;
  $('#teamSearchStatus').textContent = 'Buscando…';
  $('#teamSearchBtn').disabled = true;
  try {
    const results = await api(`/api/setup/team-search?q=${encodeURIComponent(q)}`);
    $('#teamSearchStatus').textContent = `${results.length} atleta(s) encontrado(s) com "${q}" na academia.`;
    renderTeamSearchResults(results);
  } catch (err) {
    $('#teamSearchStatus').textContent = `Erro: ${err.message}`;
  } finally {
    $('#teamSearchBtn').disabled = false;
  }
});

function renderTeamSearchResults(results) {
  const el = $('#teamSearchResults');
  el.innerHTML = '';
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'suggestion-card';
    const guessedEvent = guessEventFromCategoryName(r.categoryName);
    row.innerHTML = `
      <div class="suggestion-name">${escapeHtml(r.name)}</div>
      <div class="suggestion-sub">${escapeHtml(r.team || '')} · ${escapeHtml(r.categoryName || '')}</div>
      <div class="add-athlete-form">
        <select class="tsDay">
          <option value="THU">Qui</option>
          <option value="FRI">Sex</option>
          <option value="SAT">Sáb</option>
        </select>
        <select class="tsEvent">
          <option value="WM" ${guessedEvent === 'WM' ? 'selected' : ''}>World Master</option>
          <option value="CON" ${guessedEvent === 'CON' ? 'selected' : ''}>Jiu Jitsu CON</option>
          <option value="KIDS" ${guessedEvent === 'KIDS' ? 'selected' : ''}>Kids</option>
        </select>
        <button class="primary-btn tsAdd">+ Adicionar e mapear</button>
      </div>
    `;
    row.querySelector('.tsAdd').addEventListener('click', async (ev) => {
      const btn = ev.target;
      btn.disabled = true;
      btn.textContent = 'Adicionando…';
      try {
        await api('/api/setup/team-search/add', {
          method: 'POST',
          body: JSON.stringify({
            name: r.name,
            categoryUrl: r.categoryUrl,
            categoryName: r.categoryName,
            tournamentUrl: r.tournamentUrl,
            tournamentId: r.tournamentId,
            siteName: r.name,
            day: row.querySelector('.tsDay').value,
            event: row.querySelector('.tsEvent').value,
          }),
        });
        btn.textContent = '✅ Adicionado';
        loadRosterMgmt();
        loadStatus();
      } catch (err) {
        btn.textContent = `Erro: ${err.message}`;
        btn.disabled = false;
      }
    });
    el.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Roster management
// ---------------------------------------------------------------------------

async function loadRosterMgmt() {
  const roster = await api('/api/roster');
  const el = $('#rosterMgmt');
  el.innerHTML = '';
  for (const r of roster) {
    const row = document.createElement('div');
    row.className = 'roster-row';
    row.innerHTML = `
      <span class="rname">${escapeHtml(r.name)} <span class="rstatus">${escapeHtml(state.dayLabels[r.day] || r.day)} · ${escapeHtml(state.eventLabels[r.event] || r.event)}${r.mapped ? ' · ✅ mapeado' : ''}</span></span>
      <button data-id="${r.id}" class="del-athlete">🗑</button>
    `;
    row.querySelector('.del-athlete').addEventListener('click', async () => {
      if (!confirm(`Remover ${r.name} do roster?`)) return;
      await api(`/api/roster/${r.id}`, { method: 'DELETE' });
      loadRosterMgmt();
    });
    el.appendChild(row);
  }
}

$('#addAthleteBtn').addEventListener('click', async () => {
  const name = $('#newName').value.trim();
  if (!name) return;
  await api('/api/roster', {
    method: 'POST',
    body: JSON.stringify({
      name,
      day: $('#newDay').value,
      event: $('#newEvent').value,
      baseTime: $('#newTime').value.trim() || null,
      baseMat: $('#newMat').value.trim() || null,
    }),
  });
  $('#newName').value = '';
  $('#newTime').value = '';
  $('#newMat').value = '';
  loadRosterMgmt();
});

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

$('#loadLogBtn').addEventListener('click', async () => {
  const log = await api('/api/log');
  const el = $('#logList');
  el.innerHTML = '';
  for (const entry of [...log].reverse()) {
    const li = document.createElement('li');
    li.textContent = `${new Date(entry.timestamp).toLocaleTimeString()} — ${entry.athleteName}: ${entry.result} vs ${(entry.opponents || []).join(', ')} (MAT ${entry.mat}, luta ${entry.fightNumber})`;
    el.appendChild(li);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  await loadMeta();
  await loadStatus();
  setInterval(loadStatus, 30000);
})();

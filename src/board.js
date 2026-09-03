'use strict';

// Transforma o estado bruto (roster + mappings + categorias raspadas) no
// painel que a UI consome: status por atleta, urgência, fila no tatame e
// conflitos de horário.

const { state, isCovered } = require('./store');

const DAY_TO_WEEKDAY = { THU: 4, FRI: 5, SAT: 6 }; // Date#getDay(): dom=0 ... sáb=6

function parseTimeToMinutes(raw) {
  if (!raw) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (!ampm) {
    // sem AM/PM explícito: horários de competição são diurnos (8h-22h). Se
    // vier < 8, assume-se PM (ex.: "3:06" == 15:06), igual à heurística do roster default.
    if (h < 8) h += 12;
  }
  return h * 60 + min;
}

function findAthleteFights(fights, siteName) {
  const needle = String(siteName || '').toLowerCase();
  if (!needle) return [];
  return fights.filter((f) => f.athletes.some((a) => a.toLowerCase() === needle));
}

// Ordena as lutas do atleta na ordem em que aconteceram/vão acontecer:
// por horário quando disponível, senão por número da luta.
function sortFights(fights) {
  return [...fights].sort((a, b) => {
    const ta = parseTimeToMinutes(a.scheduledTime);
    const tb = parseTimeToMinutes(b.scheduledTime);
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    return (a.fightNumber || 0) - (b.fightNumber || 0);
  });
}

function buildAthleteEntry(rosterEntry, nowMinutes, todayWeekday) {
  const mapping = state.mappings[rosterEntry.id];
  const base = {
    athleteId: rosterEntry.id,
    name: rosterEntry.name,
    day: rosterEntry.day,
    event: rosterEntry.event,
    modality: rosterEntry.modality,
    baseTime: rosterEntry.baseTime,
    baseMat: rosterEntry.baseMat,
    mapped: !!(mapping && mapping.confirmed),
    categoryName: mapping ? mapping.categoryName : null,
    siteName: mapping ? mapping.siteName : null,
  };

  if (!mapping || !mapping.confirmed) {
    return { ...base, phase: 'unmapped', badge: 'aguardando', urgency: 'none', nextFight: null };
  }

  const catData = state.categories[mapping.categoryUrl];
  const fights = catData ? catData.fights : [];
  const mine = sortFights(findAthleteFights(fights, mapping.siteName));

  base.categoryFetchedAt = catData ? catData.fetchedAt : null;
  base.categoryError = catData ? catData.lastError : null;

  if (mine.length === 0) {
    return { ...base, phase: 'waiting', badge: 'aguardando', urgency: 'none', nextFight: null };
  }

  const upcoming = mine.filter((f) => f.status !== 'done');
  const done = mine.filter((f) => f.status === 'done');
  const lastDone = done[done.length - 1] || null;

  if (upcoming.length > 0) {
    const next = upcoming[0];
    const scheduledMinutes = parseTimeToMinutes(next.scheduledTime);
    const dayMatches = DAY_TO_WEEKDAY[rosterEntry.day] === todayWeekday;

    // posição na fila: quantas lutas ainda não terminaram, no mesmo tatame,
    // aparecem antes dela nesta categoria (aproximação — não vemos o mat inteiro).
    const sameMat = next.mat
      ? fights.filter((f) => f.mat === next.mat && f.status !== 'done')
      : [];
    const sortedSameMat = sortFights(sameMat);
    const queuePos = next.mat
      ? sortedSameMat.findIndex((f) => f.fightNumber === next.fightNumber)
      : null;

    let urgency = 'later';
    let minutesUntil = scheduledMinutes != null ? scheduledMinutes - nowMinutes : null;
    if (dayMatches) {
      if ((queuePos === 0) || (minutesUntil != null && minutesUntil <= 5)) urgency = 'now';
      else if (minutesUntil != null && minutesUntil <= 20) urgency = 'soon';
      else urgency = 'later';
    } else {
      urgency = 'later';
    }

    return {
      ...base,
      phase: 'queued',
      badge: lastDone ? 'lutou' : 'na_fila',
      lastResult: lastDone ? (lastDone.winner && lastDone.winner.toLowerCase() === String(mapping.siteName).toLowerCase() ? 'W' : 'L') : null,
      urgency,
      minutesUntil,
      nextFight: {
        fightNumber: next.fightNumber,
        mat: next.mat,
        scheduledTime: next.scheduledTime,
        scheduledMinutes,
        opponents: next.athletes.filter((a) => a.toLowerCase() !== String(mapping.siteName).toLowerCase()),
        queuePosition: queuePos != null && queuePos >= 0 ? queuePos : null,
        bye: next.bye,
        covered: isCovered(rosterEntry.id, next.fightNumber),
      },
    };
  }

  // sem lutas futuras conhecidas na categoria
  if (lastDone) {
    const won = lastDone.winner && lastDone.winner.toLowerCase() === String(mapping.siteName).toLowerCase();
    if (!won) {
      return {
        ...base,
        phase: 'finished',
        badge: 'eliminado',
        lastResult: 'L',
        urgency: 'none',
        nextFight: null,
        finalFight: lastDone,
      };
    }
    // venceu a última luta conhecida e não há próxima agendada ainda.
    // Heurística: se essa foi a luta de maior número da categoria, assume-se
    // final (campeão). Senão, está avançando e aguardando a chave atualizar.
    const maxFightNumber = Math.max(0, ...fights.map((f) => f.fightNumber || 0));
    const isLikelyFinal = (lastDone.fightNumber || 0) >= maxFightNumber;
    if (isLikelyFinal) {
      return {
        ...base,
        phase: 'finished',
        badge: 'campeao',
        lastResult: 'W',
        urgency: 'none',
        nextFight: null,
        finalFight: lastDone,
      };
    }
    return {
      ...base,
      phase: 'waiting',
      badge: 'lutou',
      lastResult: 'W',
      urgency: 'none',
      nextFight: null,
      note: 'Venceu — aguardando chave gerar a próxima luta',
    };
  }

  return { ...base, phase: 'waiting', badge: 'aguardando', urgency: 'none', nextFight: null };
}

function detectConflicts(entries) {
  const active = entries.filter((e) => e.nextFight && e.nextFight.scheduledMinutes != null);
  const pairs = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.day !== b.day) continue;
      if (a.nextFight.mat === b.nextFight.mat) continue; // mesmo tatame não é "conflito de deslocamento"
      const gap = Math.abs(a.nextFight.scheduledMinutes - b.nextFight.scheduledMinutes);
      if (gap <= 20) {
        const matA = parseInt(a.nextFight.mat, 10);
        const matB = parseInt(b.nextFight.mat, 10);
        const matDistance = Number.isFinite(matA) && Number.isFinite(matB) ? Math.abs(matA - matB) : null;
        pairs.push({ a: a.athleteId, b: b.athleteId, gapMinutes: gap, matDistance });
      }
    }
  }

  // agrupa pares conectados em clusters (union-find simples)
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const p of pairs) {
    find(p.a);
    find(p.b);
    union(p.a, p.b);
  }
  const clusters = new Map();
  for (const p of pairs) {
    const root = find(p.a);
    if (!clusters.has(root)) clusters.set(root, { athleteIds: new Set(), minGap: Infinity, minMatDistance: null });
    const c = clusters.get(root);
    c.athleteIds.add(p.a);
    c.athleteIds.add(p.b);
    c.minGap = Math.min(c.minGap, p.gapMinutes);
    if (p.matDistance != null) c.minMatDistance = c.minMatDistance == null ? p.matDistance : Math.min(c.minMatDistance, p.matDistance);
  }

  const conflictAthleteIds = new Set(pairs.flatMap((p) => [p.a, p.b]));
  const clusterList = [...clusters.values()].map((c) => ({
    athleteIds: [...c.athleteIds],
    gapMinutes: c.minGap,
    matDistance: c.minMatDistance,
  }));

  return { conflictAthleteIds, clusters: clusterList };
}

const URGENCY_ORDER = { now: 0, soon: 1, later: 2, none: 3 };

function buildBoard({ day, event } = {}) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayWeekday = now.getDay();

  let entries = state.roster.map((r) => buildAthleteEntry(r, nowMinutes, todayWeekday));

  if (day) entries = entries.filter((e) => e.day === day);
  if (event) entries = entries.filter((e) => e.event === event);

  const { conflictAthleteIds, clusters } = detectConflicts(entries);
  entries = entries.map((e) => ({ ...e, conflict: conflictAthleteIds.has(e.athleteId) }));

  const active = entries.filter((e) => e.urgency !== 'none');
  const finished = entries.filter((e) => e.phase === 'finished');
  const waiting = entries.filter((e) => e.phase === 'waiting' || e.phase === 'unmapped');

  active.sort((e1, e2) => {
    const u = URGENCY_ORDER[e1.urgency] - URGENCY_ORDER[e2.urgency];
    if (u !== 0) return u;
    const m1 = e1.nextFight ? e1.nextFight.scheduledMinutes : null;
    const m2 = e2.nextFight ? e2.nextFight.scheduledMinutes : null;
    if (m1 == null && m2 == null) return 0;
    if (m1 == null) return 1;
    if (m2 == null) return -1;
    return m1 - m2;
  });

  return {
    generatedAt: now.toISOString(),
    lastPollAt: state.lastPollAt,
    lastPollOk: state.lastPollOk,
    lastPollErrors: state.lastPollErrors,
    active,
    waiting,
    finished,
    conflicts: clusters,
  };
}

module.exports = { buildBoard, parseTimeToMinutes };

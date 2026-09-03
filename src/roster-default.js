'use strict';

// Roster inicial transcrito da spec (seção 6). Isso é só o ponto de partida —
// o app cruza esses nomes com as categorias reais do bjjcompsystem.com no
// fluxo de setup e guarda o resultado em data/state.json. Editável depois
// pela UI (ou direto no JSON) sem precisar mexer neste arquivo.

const DAY_LABELS = {
  THU: 'Qui',
  FRI: 'Sex',
  SAT: 'Sáb',
};

const EVENT_LABELS = {
  WM: 'World Master',
  CON: 'Jiu Jitsu CON',
  KIDS: 'Jiu Jitsu CON Kids',
};

// Heurística só para ordenar a tela ANTES de termos horário real do site.
// Assume-se manhã para >=8, tarde para <8 (times tipo "3:06" == 15:06).
function guessMinutes(baseTime) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(baseTime.trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 8) h += 12;
  return h * 60 + min;
}

let _id = 0;
function entry(day, name, baseTime, baseMat, event, modality) {
  _id += 1;
  return {
    id: `a${_id}`,
    name,
    day,
    event,
    modality: modality || null,
    baseTime,
    baseMinutesGuess: guessMinutes(baseTime),
    baseMat: String(baseMat),
  };
}

const ROSTER = [
  // ---- World Master ----
  entry('THU', 'Gabriel Castro', '9:54', 21, 'WM'),
  entry('THU', 'David Fadel Neto', '11:05', 22, 'WM'),
  entry('THU', 'Gabriella Fernandes', '11:14', 6, 'WM'),
  entry('THU', 'Thainara Aparecida F. da Silveira', '11:22', 12, 'WM'),
  entry('THU', 'Bruna Valois', '11:44', 17, 'WM'),
  entry('THU', 'Rodrigo Freitas', '12:19', 28, 'WM'),
  entry('FRI', 'Jeremiah Mendoza', '9:51', 24, 'WM'),
  entry('FRI', 'Erik Landaverde', '10:26', 7, 'WM'),
  entry('FRI', 'Diego Abreu', '11:29', 19, 'WM'),
  entry('FRI', 'David Kaul', '12:39', 21, 'WM'),
  entry('SAT', 'Scott Kawasaki', '9:44', 24, 'WM'),
  entry('SAT', 'Israel Ortiz', '10:54', 17, 'WM'),
  entry('SAT', 'Connie Tran', '11:15', 'TBD', 'WM'),
  entry('SAT', 'Damien Howard', '11:29', 25, 'WM'),
  entry('SAT', 'Mickey Tran', '11:29', 27, 'WM'),
  entry('SAT', 'Oliver Ceely', '11:43', 27, 'WM'),
  entry('SAT', 'Nicholas Schumacher', '3:06', 27, 'WM'),

  // ---- Jiu Jitsu CON / CON NOGI (adultos) ----
  entry('THU', 'Camila Kaul', '10:40', 37, 'CON', 'GI'),
  entry('THU', 'Winston Park', '11:01', 56, 'CON', 'GI'),
  entry('THU', 'Lukas Freitas', '12:36', 48, 'CON', 'GI'),
  entry('THU', 'David Montalvo', '1:36', 35, 'CON', 'GI'),
  entry('THU', 'Gabriella Fernandes', '3:09', 54, 'CON', 'GI'),
  entry('THU', 'Beatriz Rodrigues', '4:33', 54, 'CON', 'GI'),
  entry('FRI', 'Lukas Freitas', '1:30', 48, 'CON', 'NOGI'),
  entry('FRI', 'Gabriella Fernandes', '3:26', 58, 'CON', 'NOGI'),
  entry('FRI', 'Mariana Piccolo', '3:45', 50, 'CON', 'NOGI'),
  entry('FRI', 'Ira Lays', '5:03', 54, 'CON', 'NOGI'),

  // ---- Jiu Jitsu CON KIDS / KIDS NOGI ----
  entry('FRI', 'Breyden Kawasaki', '10:54', 45, 'KIDS', 'NOGI'),
  entry('FRI', 'Kauê Victor', '11:00', 37, 'KIDS', 'NOGI'),
  entry('FRI', 'Michael Kawasaki', '1:22', 44, 'KIDS', 'NOGI'),
  entry('SAT', 'Kauê Victor', '11:54', 56, 'KIDS', 'GI'),
  entry('SAT', 'Eloy Miron Jr.', '11:54', 45, 'KIDS', 'GI'),
  entry('SAT', 'Dean Kaul', '12:32', 41, 'KIDS', 'GI'),
  entry('SAT', 'Luca Ortiz', '12:56', 37, 'KIDS', 'GI'),
  entry('SAT', 'Michael Kawasaki', '1:11', 43, 'KIDS', 'GI'),
  entry('SAT', 'Maitê Freitas', '1:21', 42, 'KIDS', 'GI'),
  entry('SAT', 'Aaliyah Tate', '4:24', 51, 'KIDS', 'GI'),
  entry('SAT', 'Magnus Tran', '4:59', 55, 'KIDS', 'GI'),
];

module.exports = { ROSTER, DAY_LABELS, EVENT_LABELS };

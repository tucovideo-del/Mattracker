'use strict';

// Normalização + matching fuzzy de nomes (acento-insensível), pra achar
// "Kauê Victor" mesmo que o site liste "Kaue Victor" ou "VICTOR, KAUE".

function normalize(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(str) {
  return normalize(str).split(' ').filter(Boolean);
}

// Distância de Levenshtein simples, usada só em tokens curtos (nomes), então
// custo é irrelevante.
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[bl];
}

function tokenSimilar(a, b) {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3) {
    const dist = levenshtein(a, b);
    return dist <= 1 || (dist <= 2 && Math.min(a.length, b.length) >= 6);
  }
  return false;
}

// Score 0..1 de o quanto `candidateName` (nome achado no site) bate com
// `rosterName` (nome do roster monitorado). Ordem das palavras não importa
// (sites às vezes listam "SOBRENOME, Nome").
function scoreMatch(rosterName, candidateName) {
  const rTokens = tokens(rosterName);
  const cTokens = tokens(candidateName);
  if (rTokens.length === 0 || cTokens.length === 0) return 0;

  const used = new Set();
  let matched = 0;
  for (const rt of rTokens) {
    let bestIdx = -1;
    for (let i = 0; i < cTokens.length; i++) {
      if (used.has(i)) continue;
      if (tokenSimilar(rt, cTokens[i])) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      matched += 1;
    }
  }
  return matched / rTokens.length;
}

// Retorna candidatos ordenados por score desc, score >= threshold.
function findCandidates(rosterName, candidateNames, threshold = 0.5) {
  const seen = new Map(); // normalized -> best entry (evita duplicar mesmo nome)
  for (const name of candidateNames) {
    const score = scoreMatch(rosterName, name);
    if (score < threshold) continue;
    const key = normalize(name);
    const existing = seen.get(key);
    if (!existing || score > existing.score) {
      seen.set(key, { name, score });
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

module.exports = { normalize, tokens, scoreMatch, findCandidates, levenshtein };

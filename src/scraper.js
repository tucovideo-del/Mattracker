'use strict';

// Scraper do bjjcompsystem.com.
//
// IMPORTANTE (leia o README): este sandbox de build não tem acesso de rede
// ao bjjcompsystem.com, então o parser abaixo foi escrito de forma
// DEFENSIVA — várias estratégias em cascata — em vez de amarrado a
// seletores CSS específicos que eu não pude confirmar ao vivo. No dia do
// evento, use GET /api/debug/category?url=... pra ver exatamente o que foi
// extraído de uma categoria real e, se precisar, ajuste as estratégias
// abaixo (estão isoladas e comentadas).

const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 MatTracker/1.0';

async function fetchHtml(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ao buscar ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function absolutize(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lista de categorias de um tournament
// ---------------------------------------------------------------------------

// Aceita a URL completa que o operador colar — na prática o
// bjjcompsystem.com usa vários formatos (`/tournaments/{id}/categories`,
// `/tournaments/{id}/tournament_days/{day_id}`, etc.), então NÃO mexemos
// no path de uma URL já completa, só normalizamos o caso de vir só o id.
function categoriesUrlFromInput(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) {
    return `https://bjjcompsystem.com/tournaments/${s}/categories`;
  }
  try {
    return new URL(s).toString();
  } catch {
    return s;
  }
}

function tournamentIdFromUrl(url) {
  const m = /tournaments\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

async function fetchCategoriesList(tournamentUrlOrId) {
  const listUrl = categoriesUrlFromInput(tournamentUrlOrId);

  // Formato real do site: /tournaments/{id}/tournament_days/{day_id},
  // paginado por tatame (?page=N). Descoberto ao vivo pelo Tuco — ver
  // discoverTournamentDayPages() acima pra detalhes dos critérios de parada.
  if (isTournamentDayUrl(listUrl)) {
    const pages = await discoverTournamentDayPages(listUrl);
    return {
      tournamentId: tournamentIdFromUrl(listUrl),
      sourceUrl: listUrl,
      categories: pages.map((p) => ({ url: p.url, name: p.name, fights: p.fights })),
    };
  }

  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  const seen = new Map();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/(categor(y|ies)|bracket)[a-z]*\/\d+/i.test(href)) return;
    const abs = absolutize(href, listUrl);
    if (!abs) return;
    const name = $(el).text().replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (!seen.has(abs)) seen.set(abs, name);
  });

  // Fallback: sistemas que renderizam a lista via JSON embutido em <script>
  // (ex: janela __INITIAL_STATE__ ou similar). Procura padrões id+nome.
  if (seen.size === 0) {
    $('script').each((_, el) => {
      const content = $(el).contents().text();
      if (!content || content.length > 500000) return;
      const re = /"id"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"([^"]+)"/g;
      let m;
      while ((m = re.exec(content))) {
        const abs = `https://bjjcompsystem.com/categories/${m[1]}`;
        if (!seen.has(abs)) seen.set(abs, m[2]);
      }
    });
  }

  // Fallback final: a página não linka pra sub-páginas de categoria — ela
  // JÁ contém as lutas direto (comum em páginas de "dia do campeonato" tipo
  // /tournament_days/{id}). Trata a própria URL como uma categoria só, e
  // fetchCategoryFights faz o full-text-scan nela igual faria numa categoria de verdade.
  if (seen.size === 0) {
    const pageTitle =
      $('h1').first().text().replace(/\s+/g, ' ').trim() ||
      $('title').first().text().replace(/\s+/g, ' ').trim() ||
      listUrl;
    seen.set(listUrl, pageTitle);
  }

  return {
    tournamentId: tournamentIdFromUrl(listUrl),
    sourceUrl: listUrl,
    categories: [...seen.entries()].map(([url, name]) => ({ url, name })),
  };
}

// ---------------------------------------------------------------------------
// Lutas de uma categoria
// ---------------------------------------------------------------------------

const RE_FIGHT = /(?:fight|luta)\s*#?\s*(\d+)/i;
const RE_MAT = /(?:mat|tatame)\s*#?\s*(\d+)/i;
const RE_TIME = /\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/i;
const RE_WINNER_LABEL = /(?:winner|vencedor)\s*[:\-]?\s*([a-zà-ÿ.'\- ]{3,60})/i;
const RE_BYE = /\bbye\b/i;
const NOISE_LINE =
  /^(fight|luta|mat|tatame|round|winner|vencedor|vs\.?|x|time|hor[aá]rio|result(ado)?|bracket|chave)$/i;

function looksLikeName(s) {
  const t = s.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (/\d/.test(t)) return false;
  if (NOISE_LINE.test(t)) return false;
  if (RE_MAT.test(t) || RE_FIGHT.test(t) || RE_TIME.test(t)) return false;
  return /[a-zà-ÿ]/i.test(t);
}

// No bjjcompsystem.com o nome do atleta vem em CAIXA ALTA e a
// academia/equipe embaixo em texto normal (ex.: "THAINARA APARECIDA..." /
// "David Fadel Brazilian Jiu-Jitsu") — usamos isso pra separar as duas
// coisas em vez de tratar qualquer linha "parece nome" como atleta.
function isAllCapsName(s) {
  const letters = s.replace(/[^a-zà-ÿ]/gi, '');
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase();
}

// Extrai um objeto "fight" a partir de um bloco de texto livre (uma linha
// por elemento de bloco dentro do card/linha da luta). Retorna também
// `teams[]`, paralelo a `athletes[]` (mesma posição = mesmo atleta), com a
// academia quando dá pra identificar (senão null).
function parseFightBlock(lines, fallbackIndex) {
  const text = lines.join(' | ');

  const fightMatch = RE_FIGHT.exec(text);
  const matMatch = RE_MAT.exec(text);
  const timeMatch = RE_TIME.exec(text);
  const winnerMatch = RE_WINNER_LABEL.exec(text);
  const isBye = RE_BYE.test(text);

  // Nomes: tenta "A vs B" / "A x B" primeiro (times não aparecem nesse formato).
  let athletes = [];
  let teams = [];
  const vsLine = lines.find((l) => /\s+(vs\.?|x|×)\s+/i.test(l) && !RE_TIME.test(l));
  if (vsLine) {
    athletes = vsLine
      .split(/\s+(?:vs\.?|x|×)\s+/i)
      .map((s) => s.trim())
      .filter(looksLikeName);
    teams = athletes.map(() => null);
  }

  if (athletes.length < 1) {
    const nameLikeLines = lines.filter(looksLikeName);

    // Tentativa 1: emparelha CAIXA ALTA (nome, como no site real) + linha
    // seguinte que NÃO é caixa alta (equipe).
    const paired = [];
    for (let i = 0; i < lines.length && paired.length < 2; i++) {
      const line = lines[i];
      if (!looksLikeName(line) || !isAllCapsName(line)) continue;
      const next = lines[i + 1];
      const team = next && looksLikeName(next) && !isAllCapsName(next) ? next : null;
      paired.push({ name: line, team });
      if (team) i++; // já consumida como equipe
    }

    if (paired.length === 2) {
      athletes = paired.map((p) => p.name);
      teams = paired.map((p) => p.team);
    } else if (nameLikeLines.length >= 4 && nameLikeLines.length % 2 === 0) {
      // Tentativa 2: não deu pra confiar em caixa alta (ex.: o "caixa alta"
      // visual é só CSS text-transform, o texto do DOM é normal) — assume
      // alternância posicional nome/equipe/nome/equipe, mesmo padrão dos
      // exemplos reais, só que sem depender de maiúscula.
      athletes = [nameLikeLines[0], nameLikeLines[2]];
      teams = [nameLikeLines[1] || null, nameLikeLines[3] || null];
    } else {
      // Bloco simples (sem equipe, ou poucas linhas pra separar com
      // segurança) — pega as primeiras linhas que parecem nome, como antes.
      athletes = nameLikeLines.slice(0, 2);
      teams = athletes.map(() => null);
    }
  }
  athletes = athletes.map((a) => a.replace(/\s*[\(\[]?(w|win|l|loss)[\)\]]?\s*$/i, '').replace(/[✓✔]/g, '').trim());

  let winner = null;
  if (winnerMatch) {
    winner = winnerMatch[1].trim();
  } else {
    // Procura marcador tipo "(W)" ou "✓" colado no nome do atleta.
    const won = lines.find((l) => /\((w|win)\)|✓|✔/i.test(l));
    if (won) {
      winner = won.replace(/\((w|win)\)|✓|✔/gi, '').trim();
    }
  }
  if (winner) {
    const match = athletes.find((a) => a.toLowerCase() === winner.toLowerCase());
    if (!match && athletes.length) {
      // winner pode vir com formatação diferente do nome nos athletes[]; mantém como texto solto
    }
  }

  if (athletes.length === 0 && !fightMatch && !matMatch && !timeMatch) {
    return null; // bloco não parece luta nenhuma
  }

  return {
    fightNumber: fightMatch ? parseInt(fightMatch[1], 10) : fallbackIndex,
    mat: matMatch ? matMatch[1] : null,
    scheduledTime: timeMatch ? timeMatch[1].toUpperCase().replace(/\s+/g, '') : null,
    athletes,
    teams, // paralelo a athletes — academia de cada um, quando identificável
    winner,
    bye: isBye,
    status: winner ? 'done' : 'scheduled',
    raw: text.slice(0, 400),
  };
}

// Extrai uma "linha" de texto por nó-folha dentro de um elemento — preserva
// a separação entre coisas empilhadas em divs/spans aninhados (ex.: nome do
// atleta numa linha, academia na linha de baixo, dentro da MESMA célula).
// Sem isso, um `.text()` direto grudaria "NOME ATLETAAcademia Tal" sem
// espaço, e o parser não teria como separar as duas coisas.
function leafLines($, el) {
  const lines = [];
  $(el)
    .find('*')
    .addBack()
    .each((_, node) => {
      if (node.type === 'text') return;
      const own = $(node).clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
      if (own) lines.push(own);
    });
  return lines;
}

// Estratégia A: linhas de tabela (<tr>).
function strategyTableRows($) {
  const fights = [];
  $('table').each((_, table) => {
    $(table)
      .find('tr')
      .each((i, tr) => {
        const cellEls = $(tr).find('td,th').toArray();
        if (cellEls.length < 2) return;
        const lines = cellEls.flatMap((c) => leafLines($, c));
        if (lines.length < 2) return;
        const fight = parseFightBlock(lines, fights.length + 1);
        if (fight) fights.push(fight);
      });
  });
  return fights;
}

// Estratégia B: cards/elementos de bracket comuns (match/seed/fight/game).
function strategyBracketCards($) {
  const fights = [];
  const sel = '.match, .seed, .fight, .game, .bracket-match, [class*="match"], [class*="fight"]';
  $(sel).each((_, el) => {
    const $el = $(el);
    // ignora containers grandes demais (provavelmente a chave inteira, não uma luta)
    if ($el.find(sel).length > 0) return;
    const lines = leafLines($, el);
    if (lines.length === 0) return;
    const fight = parseFightBlock(lines, fights.length + 1);
    if (fight) fights.push(fight);
  });
  return fights;
}

// Estratégia C (fallback final): varre todo o texto em blocos, segmentando
// por ocorrências de "FIGHT n" / "LUTA n".
function strategyFullTextScan($) {
  const blockSelector = 'tr, li, p, div';
  const lines = [];
  $(blockSelector).each((_, el) => {
    const $el = $(el);
    if ($el.children(blockSelector).length > 0) return; // só folhas
    const t = $el.text().replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
  });

  const fights = [];
  let current = [];
  const flush = () => {
    if (current.length) {
      const fight = parseFightBlock(current, fights.length + 1);
      if (fight) fights.push(fight);
    }
    current = [];
  };
  for (const line of lines) {
    if (RE_FIGHT.test(line) && current.length) {
      flush();
    }
    current.push(line);
  }
  flush();
  return fights;
}

function dedupeFights(fights) {
  const byKey = new Map();
  for (const f of fights) {
    const key = f.fightNumber != null ? `n${f.fightNumber}` : `a${f.athletes.join('+')}|${f.scheduledTime}`;
    const existing = byKey.get(key);
    // prefere o registro mais "completo" (mais campos preenchidos)
    const score = (x) => [x.mat, x.scheduledTime, x.winner, x.athletes.length >= 2].filter(Boolean).length;
    if (!existing || score(f) > score(existing)) byKey.set(key, f);
  }
  return [...byKey.values()].sort((a, b) => (a.fightNumber || 0) - (b.fightNumber || 0));
}

// ---------------------------------------------------------------------------
// Estratégia D: página de tatame do bjjcompsystem.com (confirmada ao vivo).
//
// Essa página NÃO é uma lista de lutas com horário — é a ÁRVORE DE CHAVE
// completa daquele tatame, achatada em uma linha de tabela por item:
//   - cabeçalho de categoria: "Adult / Male / WHITE / Feather"
//   - nome do atleta, numa linha
//   - academia dele, na linha seguinte
//   - placeholder de vaga ainda não decidida: "Winner of Fight N, Mat M"
//   - marcador de rodada: "(QF)", "(SF)", "(F)"
// Cada cabeçalho de categoria OU marcador de rodada abre exatamente UMA
// luta (2 vagas); cada vaga é um placeholder OU um par nome+academia. Não
// tem horário nenhum nessa página — scheduledTime fica sempre null aqui.
// ---------------------------------------------------------------------------

const RE_ROUND_MARKER = /^\(\s*(r\d+|qf|sf|f|final)\s*\)$/i;
const RE_WINNER_OF = /winner of (?:fight|luta)\s*#?\s*\d+,?\s*(?:mat|tatame)\s*#?\s*(\d+)/i;

function isCategoryHeaderLine(s) {
  return (s.match(/\s\/\s/g) || []).length >= 2;
}

function strategyBjjMatSchedule($) {
  const rows = [];
  $('table').each((_, table) => {
    $(table)
      .find('tr')
      .each((_, tr) => {
        const cellEls = $(tr).find('td,th').toArray();
        const text = cellEls
          .flatMap((c) => leafLines($, c))
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) rows.push(text);
      });
  });
  // fallback: sem <table>, tenta linhas soltas (li/div/p folhas) na ordem do documento
  if (rows.length === 0) {
    $('tr, li, p, div').each((_, el) => {
      const $el = $(el);
      if ($el.children('tr, li, p, div').length > 0) return; // só folhas
      const t = $el.text().replace(/\s+/g, ' ').trim();
      if (t) rows.push(t);
    });
  }
  if (rows.length === 0) return [];

  let mat = null;
  for (const r of rows) {
    const w = RE_WINNER_OF.exec(r);
    if (w) {
      mat = w[1];
      break;
    }
  }
  if (!mat) {
    for (const r of rows) {
      const m = RE_MAT.exec(r);
      if (m) {
        mat = m[1];
        break;
      }
    }
  }

  const fights = [];
  let pending = []; // até 2 slots: { name, team } (team pode ficar null) ou { placeholder: true }
  let counter = 0;

  const flush = () => {
    const real = pending.filter((s) => s.name);
    pending = [];
    if (real.length === 0) return;
    counter += 1;
    fights.push({
      fightNumber: counter,
      mat,
      scheduledTime: null,
      athletes: real.map((s) => s.name),
      teams: real.map((s) => s.team || null),
      winner: null,
      // real.length < 2 aqui é "o outro lado ainda não foi decidido" (vaga
      // com "Winner of Fight N"), não uma bye de verdade — só marca bye
      // quando o texto "BYE" aparece mesmo como nome do oponente.
      bye: real.some((s) => RE_BYE.test(s.name)),
      status: 'scheduled',
      raw: real.map((s) => `${s.name}${s.team ? ' (' + s.team + ')' : ''}`).join(' vs ').slice(0, 400),
    });
  };

  for (const row of rows) {
    if (RE_ROUND_MARKER.test(row)) {
      flush(); // marcador de rodada fecha a luta anterior e abre uma nova
      continue;
    }
    if (isCategoryHeaderLine(row)) {
      flush(); // novo cabeçalho de categoria = nova luta (round 1)
      continue;
    }
    if (RE_WINNER_OF.test(row)) {
      pending.push({ placeholder: true });
      if (pending.length >= 2) flush();
      continue;
    }
    if (!looksLikeName(row)) continue; // número de seed solto, etc.

    const openSlot = pending.find((s) => s.name && !s.team);
    if (openSlot) {
      openSlot.team = row;
    } else {
      pending.push({ name: row });
    }
    // flusha assim que as duas vagas estiverem "fechadas" (placeholder, ou
    // nome+academia completos) — não precisa esperar o próximo cabeçalho.
    if (pending.length >= 2 && pending.every((s) => s.placeholder || s.team)) {
      flush();
    }
  }
  flush();

  return fights;
}

function parseFightsFromDom($) {
  let fights = strategyBjjMatSchedule($);
  if (fights.length === 0) fights = strategyTableRows($);
  if (fights.length === 0) fights = strategyBracketCards($);
  if (fights.length === 0) fights = strategyFullTextScan($);
  return dedupeFights(fights).filter((f) => f.athletes.length > 0 || f.mat || f.scheduledTime);
}

function extractPageTitle($) {
  return (
    $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $('h2').first().text().replace(/\s+/g, ' ').trim() ||
    $('title').first().text().replace(/\s+/g, ' ').trim() ||
    null
  );
}

async function fetchCategoryFights(categoryUrl) {
  const html = await fetchHtml(categoryUrl);
  const $ = cheerio.load(html);
  const fights = parseFightsFromDom($);
  const categoryName = extractPageTitle($);
  return { categoryUrl, categoryName, fights, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Páginas "tournament_day" — no bjjcompsystem.com cada página (?page=N) é a
// agenda de UM TATAME só naquele dia. A relação entre número da página e
// número do tatame é LINEAR mas com um offset que muda por torneio/dia
// (confirmado ao vivo: page=1 → Mat 35, page=24 → Mat 58, ou seja
// `mat = firstMat + (page - 1)`, onde firstMat é o que a page=1 mostrar).
// Isso deixa dois jeitos de achar um tatame:
//   1. RÁPIDO (usado no setup): busca a page=1 pra descobrir firstMat, daí
//      pula direto pra `page = mat - firstMat + 1` do tatame que o roster
//      já espera pro atleta — sem varrer página por página.
//   2. VARREDURA COMPLETA (fallback): pagina 1,2,3... até acabar, pra quando
//      não sabemos (ou erramos) o tatame esperado.
// ---------------------------------------------------------------------------

const TOURNAMENT_DAY_RE = /\/tournament_days\/\d+/;

function isTournamentDayUrl(url) {
  try {
    return TOURNAMENT_DAY_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function buildPageUrl(dayUrl, page) {
  const u = new URL(dayUrl);
  u.searchParams.set('page', String(page));
  return u.toString();
}

function pageNumberFromUrl(url) {
  try {
    const p = new URL(url).searchParams.get('page');
    return p ? parseInt(p, 10) : 1;
  } catch {
    return null;
  }
}

// Busca uma página específica (?page=N) de um tournament_day e já extrai o
// tatame + as lutas dela.
async function fetchTournamentDayPage(dayUrl, page) {
  const url = buildPageUrl(dayUrl, page);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const fights = parseFightsFromDom($);
  const mat = mostCommonMat(fights);
  const name = mat ? `Mat ${mat}` : extractPageTitle($) || `Página ${page}`;
  return { url, page, mat, name, fights };
}

function mostCommonMat(fights) {
  const counts = new Map();
  for (const f of fights) {
    if (!f.mat) continue;
    counts.set(f.mat, (counts.get(f.mat) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [mat, count] of counts) {
    if (count > bestCount) {
      best = mat;
      bestCount = count;
    }
  }
  return best;
}

// Varre ?page=1,2,3... de uma URL de tournament_day até acabarem os
// tatames. Critérios de parada (o site real nunca foi visto por este
// código — ver README —, então são propositalmente conservadores pra não
// cortar tatames legítimos que estejam vazios num certo momento do dia):
//   - erro de rede/HTTP (ex.: 404 numa página que não existe)
//   - conteúdo idêntico ao de QUALQUER página já vista nesta varredura
//     (sinal de que o site "grudou" no último page válido em vez de dar
//     erro pra número de página fora do range)
// Páginas sem nenhuma luta reconhecida são puladas (não viram categoria)
// mas NÃO param a varredura sozinhas — só o teto de segurança (maxPages)
// e os dois critérios acima. Isso é mais lento no pior caso, mas evita
// perder um tatame por causa de uma lacuna no meio da agenda.
async function discoverTournamentDayPages(dayUrl, { maxPages = 150 } = {}) {
  const base = new URL(dayUrl);
  base.searchParams.delete('page');

  const pages = [];
  const seenHtml = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(base.toString());
    u.searchParams.set('page', String(page));
    const pageUrl = u.toString();

    let html;
    try {
      html = await fetchHtml(pageUrl);
    } catch {
      break;
    }
    if (seenHtml.has(html)) break;
    seenHtml.add(html);

    const $ = cheerio.load(html);
    const fights = parseFightsFromDom($);
    if (fights.length === 0) continue;

    const mat = mostCommonMat(fights);
    const name = mat ? `Mat ${mat}` : extractPageTitle($) || `Página ${page}`;
    pages.push({ url: pageUrl, name, fights });
  }

  return pages;
}

// Junta todos os nomes de atletas aparecendo numa categoria (pra fase de match).
function athleteNamesFromFights(fights) {
  const set = new Set();
  for (const f of fights) {
    for (const a of f.athletes) set.add(a);
  }
  return [...set];
}

// Junta pares {name, team} únicos aparecendo numa categoria — usado na
// busca por academia (ex.: "Inspirit"). team fica null quando o parser não
// conseguiu separar a linha da academia da linha do nome.
function athleteTeamEntriesFromFights(fights) {
  const seen = new Map(); // name -> team (mantém o primeiro team não-nulo achado)
  for (const f of fights) {
    const teams = f.teams || [];
    f.athletes.forEach((name, i) => {
      const team = teams[i] || null;
      if (!seen.has(name) || (!seen.get(name) && team)) seen.set(name, team);
    });
  }
  return [...seen.entries()].map(([name, team]) => ({ name, team }));
}

module.exports = {
  fetchHtml,
  categoriesUrlFromInput,
  tournamentIdFromUrl,
  fetchCategoriesList,
  fetchCategoryFights,
  athleteNamesFromFights,
  athleteTeamEntriesFromFights,
  isTournamentDayUrl,
  buildPageUrl,
  pageNumberFromUrl,
  fetchTournamentDayPage,
  discoverTournamentDayPages,
  // exportado pra debug/testes
  _internal: {
    strategyTableRows,
    strategyBracketCards,
    strategyFullTextScan,
    strategyBjjMatSchedule,
    parseFightBlock,
    dedupeFights,
    parseFightsFromDom,
    mostCommonMat,
  },
};

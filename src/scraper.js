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

// Aceita tanto a URL completa (.../tournaments/123/categories) quanto só o id.
function categoriesUrlFromInput(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) {
    return `https://bjjcompsystem.com/tournaments/${s}/categories`;
  }
  try {
    const u = new URL(s);
    if (!/categories\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/?$/, '') + '/categories';
    }
    return u.toString();
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
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  const seen = new Map();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/categor(y|ies)\/\d+/.test(href) && !/\/categories\/\d+/.test(href)) return;
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

// Extrai um objeto "fight" a partir de um bloco de texto livre (uma linha
// por elemento de bloco dentro do card/linha da luta).
function parseFightBlock(lines, fallbackIndex) {
  const text = lines.join(' | ');

  const fightMatch = RE_FIGHT.exec(text);
  const matMatch = RE_MAT.exec(text);
  const timeMatch = RE_TIME.exec(text);
  const winnerMatch = RE_WINNER_LABEL.exec(text);
  const isBye = RE_BYE.test(text);

  // Nomes: tenta "A vs B" / "A x B" primeiro.
  let athletes = [];
  const vsLine = lines.find((l) => /\s+(vs\.?|x|×)\s+/i.test(l) && !RE_TIME.test(l));
  if (vsLine) {
    athletes = vsLine
      .split(/\s+(?:vs\.?|x|×)\s+/i)
      .map((s) => s.trim())
      .filter(looksLikeName);
  }
  if (athletes.length < 1) {
    athletes = lines.filter(looksLikeName).slice(0, 2);
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
    winner,
    bye: isBye,
    status: winner ? 'done' : 'scheduled',
    raw: text.slice(0, 400),
  };
}

// Estratégia A: linhas de tabela (<tr>).
function strategyTableRows($) {
  const fights = [];
  $('table').each((_, table) => {
    $(table)
      .find('tr')
      .each((i, tr) => {
        const cells = $(tr)
          .find('td,th')
          .map((_, c) => $(c).text().replace(/\s+/g, ' ').trim())
          .get()
          .filter(Boolean);
        if (cells.length < 2) return;
        const fight = parseFightBlock(cells, fights.length + 1);
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
    const lines = [];
    $el.find('*').addBack().each((_, node) => {
      if (node.type === 'text') return;
      const own = $(node)
        .clone()
        .children()
        .remove()
        .end()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      if (own) lines.push(own);
    });
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

async function fetchCategoryFights(categoryUrl) {
  const html = await fetchHtml(categoryUrl);
  const $ = cheerio.load(html);

  let fights = strategyTableRows($);
  if (fights.length === 0) fights = strategyBracketCards($);
  if (fights.length === 0) fights = strategyFullTextScan($);

  fights = dedupeFights(fights).filter((f) => f.athletes.length > 0 || f.mat || f.scheduledTime);

  // nome da categoria: título da página, geralmente em h1/h2
  const categoryName =
    $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $('h2').first().text().replace(/\s+/g, ' ').trim() ||
    $('title').first().text().replace(/\s+/g, ' ').trim() ||
    null;

  return { categoryUrl, categoryName, fights, fetchedAt: new Date().toISOString() };
}

// Junta todos os nomes de atletas aparecendo numa categoria (pra fase de match).
function athleteNamesFromFights(fights) {
  const set = new Set();
  for (const f of fights) {
    for (const a of f.athletes) set.add(a);
  }
  return [...set];
}

module.exports = {
  fetchHtml,
  categoriesUrlFromInput,
  tournamentIdFromUrl,
  fetchCategoriesList,
  fetchCategoryFights,
  athleteNamesFromFights,
  // exportado pra debug/testes
  _internal: { strategyTableRows, strategyBracketCards, strategyFullTextScan, parseFightBlock, dedupeFights },
};

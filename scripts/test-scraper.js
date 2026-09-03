'use strict';

// Teste offline do parser contra HTML sintético (não bate na rede).
// Roda com: node scripts/test-scraper.js

const cheerio = require('cheerio');
const { _internal } = require('../src/scraper');
const { strategyTableRows, strategyBracketCards, strategyFullTextScan } = _internal;

// Reproduz a estrutura real do bjjcompsystem.com (visto por Tuco ao vivo):
// nome do atleta numa linha, ACADEMIA na linha de baixo, dentro da MESMA
// célula — precisa separar as duas, não tratar a academia como se fosse o
// segundo atleta.
const teamTableHtml = `
<html><body>
<h1>Master 1 Female Brown Middle</h1>
<table>
  <tr>
    <td>FIGHT 13</td><td>MAT 22</td><td>11:05 AM</td>
    <td><div class="seed">25</div><div class="name">JOSHUA ROY HINGER</div><div class="team">Seraphim Jiu-Jitsu</div></td>
    <td><div class="seed">41</div><div class="name">DAVID FADEL NETO</div><div class="team">David Fadel Brazilian Jiu-Jitsu</div></td>
    <td></td>
  </tr>
</table>
</body></html>
`;

const tableHtml = `
<html><body>
<h1>Master 4 / Black / Medium-Heavy</h1>
<table>
  <tr><th>Fight</th><th>Mat</th><th>Time</th><th>Athlete 1</th><th>Athlete 2</th><th>Result</th></tr>
  <tr><td>FIGHT 12</td><td>MAT 27</td><td>11:29 AM</td><td>Mickey Tran</td><td>John Smith</td><td></td></tr>
  <tr><td>FIGHT 13</td><td>MAT 27</td><td>11:43 AM</td><td>Oliver Ceely</td><td>BYE</td><td></td></tr>
  <tr><td>FIGHT 8</td><td>MAT 27</td><td>10:50 AM</td><td>Mickey Tran</td><td>Carlos Reyes</td><td>Winner: Mickey Tran</td></tr>
</table>
</body></html>
`;

const cardHtml = `
<html><body>
<h1>Kids Gi / Blue / Light</h1>
<div class="bracket">
  <div class="match">
    <div class="meta">FIGHT 4 - MAT 37 - 11:00 AM</div>
    <div class="team">Kaue Victor</div>
    <div class="team">Ryan Diaz</div>
  </div>
  <div class="match">
    <div class="meta">FIGHT 5 - MAT 37 - 11:20 AM</div>
    <div class="team">Kaue Victor (W)</div>
    <div class="team">Tommy Lee</div>
  </div>
</div>
</body></html>
`;

const textHtml = `
<html><body>
<h1>Adult Gi / Purple / Feather</h1>
<div>
  <p>FIGHT 20</p>
  <p>MAT 48</p>
  <p>12:36 PM</p>
  <p>Lukas Freitas vs Andre Souza</p>
</div>
<div>
  <p>FIGHT 21</p>
  <p>MAT 48</p>
  <p>12:50 PM</p>
  <p>Lukas Freitas vs Bye</p>
</div>
</body></html>
`;

function run(name, html, fn) {
  const $ = cheerio.load(html);
  const fights = fn($);
  console.log(`\n=== ${name} (${fights.length} fights) ===`);
  for (const f of fights) {
    console.log(JSON.stringify(f));
  }
  return fights;
}

const r1 = run('strategyTableRows', tableHtml, strategyTableRows);
const r2 = run('strategyBracketCards', cardHtml, strategyBracketCards);
const r3 = run('strategyFullTextScan', textHtml, strategyFullTextScan);
const r4 = run('strategyTableRows (nome+academia na mesma célula)', teamTableHtml, strategyTableRows);

let ok = true;
if (r1.length < 2) { console.error('FAIL: table strategy found too few fights'); ok = false; }
if (!r1.some(f => f.athletes.includes('Mickey Tran') && f.mat === '27')) { console.error('FAIL: table strategy missing Mickey Tran/mat27'); ok = false; }
if (r2.length < 1) { console.error('FAIL: card strategy found no fights'); ok = false; }
if (!r2.some(f => f.athletes.some(a => /Kaue Victor/i.test(a)))) { console.error('FAIL: card strategy missing Kaue Victor'); ok = false; }
if (r3.length < 1) { console.error('FAIL: text scan found no fights'); ok = false; }
if (!r3.some(f => f.athletes.some(a => /Lukas Freitas/i.test(a)))) { console.error('FAIL: text scan missing Lukas Freitas'); ok = false; }

const f4 = r4[0];
if (!f4) { console.error('FAIL: team-table strategy found no fight'); ok = false; }
else {
  if (!f4.athletes.includes('JOSHUA ROY HINGER') || !f4.athletes.includes('DAVID FADEL NETO')) {
    console.error('FAIL: team-table strategy did not extract both real athlete names (got: ' + JSON.stringify(f4.athletes) + ')');
    ok = false;
  }
  if (f4.athletes.some((a) => /jiu-jitsu/i.test(a))) {
    console.error('FAIL: team-table strategy leaked an academy name into athletes[]');
    ok = false;
  }
  if (!f4.teams || !f4.teams.some((t) => /Seraphim/i.test(t || '')) || !f4.teams.some((t) => /David Fadel/i.test(t || ''))) {
    console.error('FAIL: team-table strategy did not capture teams[] correctly (got: ' + JSON.stringify(f4.teams) + ')');
    ok = false;
  }
}

console.log(ok ? '\nALL OK' : '\nFAILURES ABOVE');
process.exit(ok ? 0 : 1);

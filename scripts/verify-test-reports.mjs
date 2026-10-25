// Comprueba que las suites obligatorias se ejecutaron de verdad y pasaron:
//   - Vitest: al menos 10 pruebas, 0 fallos, 0 errores, 0 omitidas.
//   - Playwright: exactamente 3 flujos E2E, todos superados.
// Con --summary imprime una tabla Markdown (para GITHUB_STEP_SUMMARY) sin fallar.
import { readFile } from 'node:fs/promises';

const summaryMode = process.argv.includes('--summary');

async function readJUnit(path) {
  let xml;
  try {
    xml = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const cases = [...xml.matchAll(/<testcase\b[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)];
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    const body = c[2] ?? '';
    if (/<failure\b|<error\b/.test(body)) failed++;
    else if (/<skipped\b/.test(body)) skipped++;
  }
  return { total: cases.length, failed, skipped, passed: cases.length - failed - skipped };
}

const vitest = await readJUnit('reports/vitest-junit.xml');
const e2e = await readJUnit('reports/playwright-junit.xml');

const problems = [];
if (!vitest) problems.push('No existe reports/vitest-junit.xml: la suite de Vitest no se ejecutó.');
else {
  if (vitest.total < 10) problems.push(`Vitest ejecutó ${vitest.total} pruebas (mínimo 10).`);
  if (vitest.failed > 0) problems.push(`Vitest: ${vitest.failed} pruebas fallidas.`);
  if (vitest.skipped > 0) problems.push(`Vitest: ${vitest.skipped} pruebas omitidas.`);
}
if (!e2e) problems.push('No existe reports/playwright-junit.xml: la suite E2E no se ejecutó.');
else {
  if (e2e.total !== 3) problems.push(`Playwright ejecutó ${e2e.total} flujos (se exigen exactamente 3).`);
  if (e2e.failed > 0) problems.push(`Playwright: ${e2e.failed} flujos fallidos.`);
  if (e2e.skipped > 0) problems.push(`Playwright: ${e2e.skipped} flujos omitidos.`);
}

const fmt = (r) => (r ? `${r.passed} / ${r.total} (fallos ${r.failed}, omitidas ${r.skipped})` : 'no ejecutada');

if (summaryMode) {
  console.log('## Resultados de pruebas\n');
  console.log('| Suite | Superadas / total |');
  console.log('|---|---|');
  console.log(`| Vitest (unitarias + integración) | ${fmt(vitest)} |`);
  console.log(`| Playwright (E2E) | ${fmt(e2e)} |`);
  for (const file of ['reports/api-benchmark.json', 'reports/latency.json', 'reports/e2e-latency.json']) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      console.log(`\n<details><summary>${file}</summary>\n\n\`\`\`json\n${JSON.stringify(data.summary ?? data, null, 2)}\n\`\`\`\n</details>`);
    } catch {
      /* informe opcional */
    }
  }
  if (problems.length > 0) console.log(`\n**Problemas:**\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(0);
}

console.log(`Vitest:     ${fmt(vitest)}`);
console.log(`Playwright: ${fmt(e2e)}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('✓ Todas las suites obligatorias se ejecutaron y pasaron.');

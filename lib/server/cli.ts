/** Operator CLI: `seed` (fresh data dir only), `eval` (scenario checks), `audit` (verify hash chain). */
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig, loadEnvFile } from './config.ts';
import { openDb } from './db.ts';
import { RecallService } from './recall.ts';
import { SandboxProvider } from './channel.ts';
import { seed } from './synth.ts';
import { verifyAuditChain } from './audit.ts';
import { runEval } from '../../eval/run.ts';

const ROOT = resolve(import.meta.dirname, '../..');
loadEnvFile(join(ROOT, '.env'));
const cmd = process.argv[2];
const cfg = loadConfig({ ...process.env, HOST: process.env.HOST ?? '127.0.0.1' });
const dataDir = resolve(ROOT, cfg.dataDir);

async function main(): Promise<number> {
  if (cmd === 'seed') {
    mkdirSync(dataDir, { recursive: true });
    const db = openDb(join(dataDir, 'loyalty.db'));
    const summary = await seed(db, cfg, new RecallService(db, cfg.recallMode), new SandboxProvider(), 80);
    console.log(JSON.stringify(summary, null, 2));
    db.close();
    return 0;
  }
  if (cmd === 'eval') {
    const report = await runEval(cfg);
    console.log(report.live ? `Live vendor checks: ${report.live}` : 'Live vendor checks skipped (AI_PROVIDER=off).');
    for (const c of report.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  -> ${c.detail}`}`);
    console.log(`\n${report.passed}/${report.checks.length} checks passed`);
    return report.passed === report.checks.length ? 0 : 1;
  }
  if (cmd === 'audit') {
    const db = openDb(join(dataDir, 'loyalty.db'));
    const r = verifyAuditChain(db);
    console.log(JSON.stringify(r));
    db.close();
    return r.ok ? 0 : 1;
  }
  console.log('usage: cli.ts <seed|eval|audit>');
  return 2;
}

main().then((code) => process.exit(code), (err) => {
  console.error((err as Error).message);
  process.exit(1);
});

// scripts/run_migration.js — run a .sql file via the Neon driver
import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: node scripts/run_migration.js <path-to-sql>');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const text = fs.readFileSync(sqlFile, 'utf8');

const statements = text
  .split(/;\s*$/m)
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.match(/^--/));

console.log(`Running ${statements.length} statements from ${sqlFile}…`);

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const firstLine = stmt.split('\n').find(l => l.trim() && !l.trim().startsWith('--')) || '';
  const label = firstLine.slice(0, 70).replace(/\s+/g, ' ');
  process.stdout.write(`  [${i + 1}/${statements.length}] ${label}…`);
  try {
    await sql.query(stmt);
    console.log(' ✓');
  } catch (e) {
    console.log(' ✗');
    console.error(`\nFailed on statement ${i + 1}:`);
    console.error(stmt);
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  }
}

console.log('\nDone.');
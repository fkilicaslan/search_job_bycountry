import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { embed, cosine } from './embeddings.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, '../data/bullet-index.json');

let _index = null;

async function loadIndex() {
  if (!_index) {
    _index = JSON.parse(await readFile(INDEX_PATH, 'utf-8'));
  }
  return _index;
}

/**
 * Return top-k bullets for a JD requirement, optionally scoped to a role.
 * @param {string} requirement  - JD requirement text to match against
 * @param {string|null} role    - Optional filter: matches bullet.company or bullet.role (case-insensitive substring)
 * @param {number} k            - Number of results to return
 * @returns {{ bullet_id, bullet_text, score }[]} sorted descending by score
 */
export async function topK(requirement, role = null, k = 5) {
  const index = await loadIndex();

  const candidates = role
    ? index.filter(b =>
        b.company?.toLowerCase().includes(role.toLowerCase()) ||
        b.role?.toLowerCase().includes(role.toLowerCase())
      )
    : index;

  if (candidates.length === 0) return [];

  const reqVec = await embed(requirement);

  const scored = candidates.map(b => ({
    bullet_id:   b.bullet_id,
    bullet_text: b.bullet_text,
    score: parseFloat(cosine(reqVec, new Float32Array(b.embedding)).toFixed(3)),
  }));

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

// CLI: node lib/bullet-retrieval.mjs --requirement="..." [--role="..."] [--k=5]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
  );
  if (!args.requirement) {
    process.stderr.write('Usage: node lib/bullet-retrieval.mjs --requirement="..." [--role="..."] [--k=5]\n');
    process.exit(1);
  }
  topK(args.requirement, args.role || null, parseInt(args.k || '5', 10))
    .then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n'))
    .catch(err => { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); });
}

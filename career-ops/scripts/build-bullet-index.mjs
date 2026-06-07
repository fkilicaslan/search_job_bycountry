#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { embed } from '../lib/embeddings.mjs';
import { getAllBullets } from '../lib/corpus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, '../data/bullet-index.json');

async function main() {
  console.log('Loading corpus…');
  const rawBullets = await getAllBullets();

  // Build embed_text: role context + bullet text (boosts domain-relevant retrieval)
  const parsed = rawBullets.map(b => ({
    role:        b.role     ?? null,
    company:     b.employer ?? null,
    bullet_id:   b.bullet_id,
    bullet_text: b.bullet_text,
    embed_text:  b.employer
      ? `${b.employer}: ${b.bullet_text}`
      : b.bullet_text,
  }));

  const roles = new Set(parsed.map(b => b.role).filter(Boolean));
  console.log(`Found ${parsed.length} bullets across ${roles.size} roles`);

  let existing = [];
  try { existing = JSON.parse(await readFile(INDEX_PATH, 'utf-8')); } catch {}
  const cache = new Map(existing.map(e => [e.bullet_id, e]));

  const result = [];
  let embedded = 0, skipped = 0;

  for (const bullet of parsed) {
    const hash = createHash('sha256').update(bullet.embed_text).digest('hex').slice(0, 16);
    const hit  = cache.get(bullet.bullet_id);
    if (hit && hit.text_hash === hash && Array.isArray(hit.embedding)) {
      result.push(hit);
      skipped++;
    } else {
      console.log(`  embedding: ${bullet.bullet_id.slice(0, 60)}`);
      const vec = await embed(bullet.embed_text);
      const { embed_text: _, ...stored } = bullet; // don't persist embed_text
      result.push({ ...stored, text_hash: hash, embedding: Array.from(vec) });
      embedded++;
    }
  }

  await writeFile(INDEX_PATH, JSON.stringify(result, null, 2));
  console.log(`Done — embedded: ${embedded}, skipped (unchanged): ${skipped}`);
  console.log(`Written → ${INDEX_PATH}`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });

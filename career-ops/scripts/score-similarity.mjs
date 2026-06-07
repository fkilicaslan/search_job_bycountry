#!/usr/bin/env node
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';
import { embed, cosine } from '../lib/embeddings.mjs';
import { safeStringify } from '../lib/safe-json.mjs';

const THRESHOLD = 0.75;

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', mdash: ' ', ndash: ' ', middot: ' ',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  euro: '€', copy: '©', reg: '®', trade: '™',
  hellip: '...', bull: '·', rarr: '→', larr: '←',
  // Extended Latin — German / Turkish / French common characters
  auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü',
  szlig: 'ß', eacute: 'é', Eacute: 'É', ecirc: 'ê', egrave: 'è',
  iacute: 'í', icirc: 'î', oacute: 'ó', ocirc: 'ô', uacute: 'ú',
  ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ', iexcl: '¡',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', aring: 'å',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð',
  thorn: 'þ', yacute: 'ý', yuml: 'ÿ',
};

function decodeHtmlEntities(str) {
  return str
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

export async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const buf = await readFile(filePath);
    const parser = new PDFParse({ data: buf });
    await parser.load();
    const result = await parser.getText();
    return result.text;
  }
  const raw = await readFile(filePath, 'utf-8');
  if (ext === '.html' || ext === '.htm') {
    return decodeHtmlEntities(
      raw
        .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    ).replace(/\s+/g, ' ').trim();
  }
  return raw;
}

export async function scoreSimilarity(jdText, cvText) {
  const [jdVec, cvVec] = await Promise.all([embed(jdText), embed(cvText)]);
  const similarity = parseFloat(cosine(jdVec, cvVec).toFixed(3));
  return { similarity, threshold: THRESHOLD, pass: similarity >= THRESHOLD };
}

async function main() {
  const args = process.argv.slice(2);
  let jdPath, cvPath;
  for (const arg of args) {
    if (arg.startsWith('--jd=')) jdPath = arg.slice(5);
    else if (arg.startsWith('--cv=')) cvPath = arg.slice(5);
  }
  if (!jdPath || !cvPath) {
    process.stderr.write('Usage: node scripts/score-similarity.mjs --jd=<path> --cv=<path>\n');
    process.exit(1);
  }

  const [jdText, cvText] = await Promise.all([extractText(jdPath), extractText(cvPath)]);
  const result = await scoreSimilarity(jdText, cvText);
  process.stdout.write(safeStringify(result) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}

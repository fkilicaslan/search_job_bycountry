import { pipeline } from '@xenova/transformers';

let _pipe = null;

async function getPipeline() {
  if (!_pipe) {
    _pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return _pipe;
}

export async function embed(text) {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return output.data; // Float32Array, length 384
}

export function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

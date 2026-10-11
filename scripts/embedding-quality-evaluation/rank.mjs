// Run the actual product ranking implementation, no reimplementation or tuning.
import { pathToFileURL } from 'node:url';
let input = ''; for await (const part of process.stdin) input += part;
const data = JSON.parse(input);
const { Bm25, tokens, cosine, fuse } = await import(pathToFileURL(process.argv[2]).href);
const bm25 = new Bm25(data.documents.map(d => tokens(`${d.title} ${d.text}`)));
const vectors = data.vectors?.map(v => Float32Array.from(v));
const output = data.queries.map((q, qi) => {
  const lexical = bm25.rank(tokens(q.text), data.documents.length).map(h => data.documents[h.index].id);
  if (!vectors) return { id: q.id, lexical };
  const query = Float32Array.from(data.queryVectors[qi]);
  const semantic = data.documents.map((d, i) => ({ id: d.id, score: cosine(query, vectors[i]) }))
    .sort((a,b) => b.score-a.score).map(d => d.id);
  const hybrid = [...fuse([lexical, semantic])].sort((a,b) => b[1]-a[1]).map(([id]) => id);
  return { id:q.id, lexical, semantic, hybrid };
});
process.stdout.write(JSON.stringify(output));

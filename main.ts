// Entry point for markdown-render-speed-02: renders every markdown case
// in the input directory to HTML and writes the results as a JSON array.
// Input:  $MAKEFUN_INPUT_DIR/cases.json (default /input)
// Output: $MAKEFUN_OUTPUT_DIR/html.json (default /output)
// Runs under Node's type stripping, so only erasable TypeScript syntax.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const decoded: unknown = JSON.parse(raw);
if (!Array.isArray(decoded)) {
  throw new Error('cases.json must contain a JSON array');
}
const cases: Case[] = decoded as Case[];
const html: string[] = cases.map((entry: Case): string => parse(entry.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));

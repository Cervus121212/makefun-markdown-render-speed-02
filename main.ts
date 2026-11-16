// Entry point for markdown-render-speed-02: renders every markdown case
// in the input directory to HTML and writes the results as a JSON array.
// Input:  $MAKEFUN_INPUT_DIR/cases.json (default /input)
// Output: $MAKEFUN_OUTPUT_DIR/html.json (default /output)
// Runs under Node's type stripping, so only erasable TypeScript syntax.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function dirsFromEnv(): { inputDir: string; outputDir: string } {
  return {
    inputDir: process.env.MAKEFUN_INPUT_DIR ?? '/input',
    outputDir: process.env.MAKEFUN_OUTPUT_DIR ?? '/output',
  };
}

function loadCases(inputDir: string): Case[] {
  const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded)) {
    throw new Error('cases.json must contain a JSON array');
  }
  return decoded as Case[];
}

function renderAll(cases: Case[]): string[] {
  const html: string[] = [];
  for (const entry of cases) html.push(parse(entry.markdown));
  return html;
}

function main(): void {
  const { inputDir, outputDir } = dirsFromEnv();
  const cases: Case[] = loadCases(inputDir);
  const html: string[] = renderAll(cases);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();

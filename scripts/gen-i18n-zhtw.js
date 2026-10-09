import fs from 'node:fs';
import path from 'node:path';
import OpenCC from 'opencc-js';

const [, , srcFile, outFile] = process.argv;
const conv = OpenCC.Converter({ from: 'cn', to: 'tw' });
const src = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
const out = {};
for (const [k, v] of Object.entries(src)) out[k] = conv(v);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`${path.basename(outFile)}: ${Object.keys(out).length} entries`);

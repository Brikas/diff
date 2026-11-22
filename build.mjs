// Bundles web/ into dist/public: hashed JS, CSS and fonts under /assets, plus index.html pointing at them.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const out = 'dist/public';
rmSync('dist', { recursive: true, force: true });
mkdirSync(`${out}/assets`, { recursive: true });

const result = await build({
  entryPoints: { app: 'web/app.ts', style: 'web/style.css' },
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022'],
  outdir: `${out}/assets`,
  entryNames: '[name]-[hash]',
  assetNames: '[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'text' },
  metafile: true,
  legalComments: 'linked',
  logLevel: 'warning',
});

// The theme picker runs as a plain blocking script in <head>, ahead of first paint.
const theme = await build({
  entryPoints: { theme: 'web/theme.ts' },
  bundle: true, minify: true, format: 'iife', target: ['es2022'],
  outdir: `${out}/assets`, entryNames: '[name]-[hash]', metafile: true, logLevel: 'warning',
});
const outputs = [...Object.keys(result.metafile.outputs), ...Object.keys(theme.metafile.outputs)];
const find = (re) => '/' + path.relative(out, outputs.find((f) => re.test(f))).split(path.sep).join('/');
const html = readFileSync('web/index.html', 'utf8')
  .replace('{{js}}', find(/assets\/app-[^/]+\.js$/))
  .replace('{{theme}}', find(/assets\/theme-[^/]+\.js$/))
  .replace('{{css}}', find(/assets\/style-[^/]+\.css$/));
writeFileSync(`${out}/index.html`, html);
copyFileSync('web/favicon.svg', `${out}/favicon.svg`);
copyFileSync('web/api.md', `${out}/api.md`);
copyFileSync('web/openapi.json', `${out}/openapi.json`);

// Anonymous-name icons: one SVG per noun from Fluent Emoji High Contrast (MIT, Microsoft), used as CSS masks.
const iconSet = JSON.parse(readFileSync('node_modules/@iconify-json/fluent-emoji-high-contrast/icons.json', 'utf8'));
const nouns = JSON.parse(readFileSync('server/anon-icons.json', 'utf8'));
mkdirSync(`${out}/anon`, { recursive: true });
for (const [noun, id] of Object.entries(nouns)) {
  const icon = iconSet.icons[id];
  if (!icon) throw new Error(`icon ${id} for ${noun} is missing from the icon set`);
  const w = icon.width ?? iconSet.width;
  const h = icon.height ?? iconSet.height;
  writeFileSync(`${out}/anon/${noun}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${icon.body}</svg>`);
}
writeFileSync(`${out}/anon/LICENSE.txt`, readFileSync('web/anon-icons-LICENSE.txt'));
console.log('built', outputs.length, 'files into', out);

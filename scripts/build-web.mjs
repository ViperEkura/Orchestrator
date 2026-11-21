import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/web', { recursive: true });
await build({ entryPoints: ['src/web/main.tsx'], bundle: true, outfile: 'dist/web/app.js', platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
await copyFile('src/web/index.html', 'dist/web/index.html');
console.log('Web client built in dist/web');

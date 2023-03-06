import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/main.js',
  external: ['vscode'],
  platform: 'node',
  format: 'cjs',
});

const buildType = process.argv[2];

const isWatch = buildType === 'watch';
const isCompile = buildType === 'compile';
const isBuild = buildType === 'build';

const base = {
  bundle: true,
  sourcemap: isCompile || isWatch,
  minify: isBuild,
  watch: isWatch && {
    onRebuild(error) {
      if (error) {
        console.error('[watch] build failed:', error);
      } else {
        console.log('[watch] build success');
      }
    }
  }
};

await esbuild.build({
  ...base,
  outfile: './out/webview.js',
  entryPoints: ['./src/webview.ts'],
  platform: 'browser',
  format: 'esm',
  target: 'es2020',
});

await esbuild.build({
  ...base,
  outfile: 'out/main.js',
  entryPoints: ['src/extension.ts'],
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'vscode-oniguruma'],
  plugins: [
    {
      name: 'copy-files',
      setup(build) {
        build.onEnd(() => {
          const outPath = path.resolve('out');
          const shikiPath = path.resolve('node_modules', 'shiki');

          for (const subdir of ['themes', 'languages']) {
            fs.cpSync(
              path.join(shikiPath, subdir),
              path.join(outPath, 'shiki', subdir),
              { recursive: true, },
            );
          }

          fs.copyFileSync(
            path.join(shikiPath, 'dist', 'onig.wasm'),
            path.join(outPath, 'shiki', 'onig.wasm'),
          );
        });
      }
    }
  ]

});

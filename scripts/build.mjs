/**
 * Build script for dsh-file-explorer.
 *
 * - Host face: src/host/index.ts → lib/index.js (ESM, node; only node builtins
 *   are imported at runtime — @deepseek-ai/* stay type-only — so the artifact
 *   needs nothing beyond the loader's own runtime).
 * - Browser face: src/client/index.ts → lib/client.js (CJS body wrapped in
 *   the official `window.__ModuleLoader__.load({ id, factory })` envelope
 *   the dsh client module system serves over /plugins; bare requires that
 *   stay in the body are resolved at runtime against the platform baseline
 *   and the enabled dynamic plugin rows).
 *
 * Run: `npm run build` (node 20+).
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Bare specifiers the browser factory may require. Everything here must be
 * satisfiable by the dsh client module system: the shell-seeded platform
 * baseline (React, cordis, static client libs) or an enabled dynamic plugin
 * row in the web profile composition.
 */
const clientExternals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
]

async function main() {
  rmSync(join(root, 'lib'), { recursive: true, force: true })
  mkdirSync(join(root, 'lib'), { recursive: true })

  // ---- host face ---------------------------------------------------------
  await build({
    entryPoints: [join(root, 'src/host/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: join(root, 'lib/index.js'),
    // Externalize every bare (package) specifier while bundling our own
    // relative sources into the single entry file. Runtime imports are node
    // builtins only, so the profile needs no extra @deepseek-ai packages.
    packages: 'external',
    logLevel: 'info',
  })

  // ---- browser face ------------------------------------------------------
  const head = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`
  const tail = `\n\t\treturn module.exports;\n\t}\n});\n`
  await build({
    entryPoints: [join(root, 'src/client/index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    outfile: join(root, 'lib/.client.body.js'),
    external: clientExternals,
    banner: { js: head },
    footer: { js: tail },
    logLevel: 'info',
  })

  // esbuild wrote head+body+tail already when banner/footer are set, so the
  // intermediate file is the final artifact under the wrapper name.
  const body = readFileSync(join(root, 'lib/.client.body.js'), 'utf8')
  writeFileSync(join(root, 'lib/client.js'), body)
  rmSync(join(root, 'lib/.client.body.js'), { force: true })

  console.log('[build] lib/index.js + lib/client.js written')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

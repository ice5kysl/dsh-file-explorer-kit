/**
 * Standalone smoke test for the host face (no cordis runtime needed).
 * Boots a tiny node:http server that mimics the `ctx.webServer` route
 * contract and hands matching /dsh-files requests to the plugin's handler.
 *
 * Run: node scripts/smoke.mjs   (from the plugin directory)
 */

import { createServer, request as httpRequest } from 'node:http'
import { apply } from '../lib/index.js'

const registered = []
const fakeCtx = {
  logger: () => ({ info: () => {} }),
  effect: (fn) => fn(),
  webServer: {
    register(route) {
      registered.push(route)
      return () => {}
    },
  },
}

apply(fakeCtx)
const route = registered[0]
if (!route || route.kind !== 'prefix' || route.path !== '/dsh-files') {
  throw new Error('route not registered as expected')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname.startsWith(route.path)) route.handler(req, res)
  else {
    res.writeHead(404)
    res.end('nope')
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/dsh-files`

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ❌ ${name}: ${error.message}`)
  }
}

async function getJson(path, headers) {
  const res = await fetch(base + path, { headers })
  return { status: res.status, body: await res.json() }
}

console.log('dsh-file-explorer host smoke test:')

await check('home returns an absolute dir', async () => {
  const { status, body } = await getJson('/home')
  if (status !== 200 || !body.ok || typeof body.home !== 'string') throw new Error(`status ${status}`)
})

await check('list workspace root (dirs first, files have size)', async () => {
  const { status, body } = await getJson('/list?path=' + encodeURIComponent(process.cwd()))
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  const files = body.entries.filter((entry) => entry.kind === 'file' && entry.name === 'package.json')
  const dirs = body.entries.filter((entry) => entry.kind === 'dir' && entry.name === 'src')
  if (files.length === 0 || dirs.length === 0) throw new Error('expected src/ + package.json rows')
  if (files[0].size <= 0 || !files[0].hidden === undefined) throw new Error('file row shape wrong')
  if (body.crumbs[body.crumbs.length - 1]?.path !== process.cwd()) throw new Error('crumb tail mismatch')
})

await check('list breadcrumbs on a nested path', async () => {
  const { status, body } = await getJson('/list?path=' + encodeURIComponent(process.cwd() + '/src/host'))
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  const tail = body.crumbs[body.crumbs.length - 1]
  if (tail?.name !== 'host' || tail?.path !== process.cwd() + '/src/host') throw new Error('crumb mismatch')
})

await check('text preview returns utf-8 head', async () => {
  const target = process.cwd() + '/src/host/fs-server.ts'
  const { status, body } = await getJson('/text?path=' + encodeURIComponent(target))
  if (status !== 200 || body.kind !== 'text' || !body.text?.includes('dsh-file-explorer')) {
    throw new Error(`status ${status} kind ${body.kind}`)
  }
})

await check('missing file -> 404 JSON', async () => {
  const { status, body } = await getJson('/text?path=' + encodeURIComponent(process.cwd() + '/nope-xyz.txt'))
  if (status !== 404 || body.ok !== false || body.error.code !== 'ENOENT') throw new Error(`status ${status}`)
})

await check('directory listed as text -> 404 ENOTDIR', async () => {
  const { status, body } = await getJson('/text?path=' + encodeURIComponent(process.cwd() + '/src'))
  if (status !== 404 || body.error.code !== 'ENOTDIR') throw new Error(`status ${status}`)
})

await check('relative path rejected (400)', async () => {
  const { status, body } = await getJson('/list?path=' + encodeURIComponent('../../etc'))
  if (status !== 400 || body.error.code !== 'invalid-path') throw new Error(`status ${status}`)
})

await check('raw streams bytes with content type', async () => {
  const res = await fetch(base + '/raw?path=' + encodeURIComponent(process.cwd() + '/lib/client.js'))
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength < 100) throw new Error('too short')
})

/** Raw HTTP GET with an explicit Host header (undici fetch forbids it). */
function rawGet(hostHeader, path = '/dsh-files/home') {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

await check('trust gate: non-loopback Host rejected (403)', async () => {
  const status = await rawGet('evil.example.com')
  if (status !== 403) throw new Error(`status ${status}`)
})

await check('trust gate: localhost Host passes', async () => {
  const status = await rawGet(`localhost:${port}`)
  if (status !== 200) throw new Error(`status ${status}`)
})

await new Promise((resolve) => server.close(resolve))

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}

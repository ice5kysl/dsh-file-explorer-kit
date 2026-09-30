/**
 * Browser-face test for dsh-file-explorer-kit (no browser needed).
 *
 * The built bundle (lib/client.js) is loaded through the official
 * `window.__ModuleLoader__` envelope and driven directly. What it pins down is
 * the stylesheet-ownership contract that a React-rendered <style> silently
 * breaks: dsh's client module loader claims every UNTAGGED <style> in the
 * document for whichever plugin materializes next, then deletes it when that
 * plugin unloads or hot-reloads — behind React's back, so the sheet is gone for
 * good and the file view renders unstyled.
 *
 * Run: npm test   (or: node tests/client.test.mjs)
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

let envelope
globalThis.window = { __ModuleLoader__: { load: (captured) => { envelope = captured } } }
await import(join(root, 'lib/client.js'))
assert.ok(envelope, 'the bundle registers itself with the module loader')
const client = envelope.factory((spec) => require_(spec))

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

/** Minimal document for the ownership contract (the same selectors the loader uses). */
function fakeStyleDocument() {
  const tags = []
  const matches = (tag, selector) => {
    if (selector === 'style:not([data-plugin])') return tag.getAttribute('data-plugin') === null
    if (selector === 'style[data-plugin]') return tag.getAttribute('data-plugin') !== null
    const byPlugin = /^style\[data-plugin="([^"]*)"\]$/.exec(selector)
    if (byPlugin) return tag.getAttribute('data-plugin') === byPlugin[1]
    const byCss = /^style\[data-plugin-css="([^"]*)"\]$/.exec(selector)
    if (byCss) return tag.getAttribute('data-plugin-css') === byCss[1]
    throw new Error(`fakeStyleDocument: unsupported selector ${selector}`)
  }
  return {
    tags,
    head: { appendChild: (node) => (tags.push(node), node) },
    createElement: () => {
      const attrs = new Map()
      const tag = {
        textContent: '',
        setAttribute: (name, value) => attrs.set(name, String(value)),
        getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
        remove: () => {
          const at = tags.indexOf(tag)
          if (at >= 0) tags.splice(at, 1)
        },
      }
      return tag
    },
    querySelector: (selector) => tags.find((tag) => matches(tag, selector)) ?? null,
    querySelectorAll: (selector) => tags.filter((tag) => matches(tag, selector)),
  }
}

// The loader's two primitives, transcribed from dsh-client-modules.
const claimStyles = (doc, id) => {
  for (const el of doc.querySelectorAll('style:not([data-plugin])')) el.setAttribute('data-plugin', id)
}
const removeOwnedStyles = (doc, id) => {
  for (const el of doc.querySelectorAll('style[data-plugin]')) if (el.getAttribute('data-plugin') === id) el.remove()
}

console.log('dsh-file-explorer-kit browser-face test:')

check('the bundle exports the stylesheet owner', () => {
  assert.equal(client.CLIENT_PLUGIN_ID, 'dsh-file-explorer-kit')
  assert.equal(typeof client.ensureExplorerStyles, 'function')
  assert.ok(client.MD_CSS.includes('.dfe-md'), 'the CSS constant rides the bundle')
})

check('ensureExplorerStyles: one package-owned tag, idempotent and self-healing', () => {
  const doc = fakeStyleDocument()
  client.ensureExplorerStyles(doc)
  assert.equal(doc.tags.length, 1, 'exactly one tag')
  assert.equal(doc.tags[0].getAttribute('data-plugin'), client.CLIENT_PLUGIN_ID, 'born owned')
  assert.equal(doc.tags[0].getAttribute('data-plugin-css'), client.CSS_TAG_ID, 'with the inventory key')
  assert.equal(doc.tags[0].textContent, client.MD_CSS, 'carrying the sheet')

  client.ensureExplorerStyles(doc)
  assert.equal(doc.tags.length, 1, 'second call is a no-op')
  doc.tags[0].remove()
  client.ensureExplorerStyles(doc)
  assert.equal(doc.tags.length, 1, 'a lost tag comes back on the next call')
})

check('the dsh module loader can neither claim nor delete our sheet', () => {
  const doc = fakeStyleDocument()
  client.ensureExplorerStyles(doc)
  claimStyles(doc, 'some-other-plugin')
  assert.equal(doc.tags[0].getAttribute('data-plugin'), client.CLIENT_PLUGIN_ID, 'never claimed by a stranger')
  removeOwnedStyles(doc, 'some-other-plugin')
  assert.equal(doc.tags.length, 1, "a stranger's reload leaves it in place")

  // The old shape proves the mechanism: an untagged tag IS stolen, then deleted.
  const reactOwned = doc.createElement('style')
  doc.head.appendChild(reactOwned)
  claimStyles(doc, 'some-other-plugin')
  assert.equal(reactOwned.getAttribute('data-plugin'), 'some-other-plugin', 'an untagged tag IS stolen')
  removeOwnedStyles(doc, 'some-other-plugin')
  assert.equal(doc.tags.includes(reactOwned), false, 'and then deleted — the failure this fix removes')
})

check('the built browser face does not render its own <style>', () => {
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.ok(bundle.includes('data-plugin'), 'the owner tag is stamped at runtime')
  assert.equal((bundle.match(/jsx\)\("style"/g) ?? []).length, 0, 'no React-rendered <style> in the bundle')
})

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

test('client.bundle.js registers with DSH module loader', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const bundlePath = join(here, '..', 'lib', 'client.bundle.js')
  const code = readFileSync(bundlePath, 'utf8')

  let registration
  const originalWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }

  try {
    ;(0, eval)(code)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }

  assert.ok(registration, 'bundle should call window.__ModuleLoader__.load')
  assert.equal(registration.id, '@dsh-external/dsh-notify')
  assert.equal(typeof registration.factory, 'function')

  const mod = registration.factory(() => { throw new Error('no require expected') })
  assert.equal(mod.name, 'dsh-notify')
  assert.deepEqual(mod.inject, ['sessions'])
  assert.equal(typeof mod.apply, 'function')
})

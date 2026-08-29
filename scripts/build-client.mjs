/**
 * Builds the DSH client loader bundle from the ESM source in lib/client.js.
 *
 * DSH's client-modules loader expects every client plugin to call
 * `window.__ModuleLoader__.load({ id, factory })`. The source stays plain ESM
 * so it can be unit-tested in Node; this script produces the wrapped bundle
 * that the browser loader actually serves.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(root, 'lib', 'client.js')
const outPath = join(root, 'lib', 'client.bundle.js')
const source = await readFile(sourcePath, 'utf8')

// Turn ESM exports into plain declarations inside the factory closure.
const body = source
  .split('\n')
  .map((line) => line.replace(/^export\s+/, ''))
  .join('\n')

const bundle = `window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-notify',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
${body}
    exports.name = name;
    exports.inject = inject;
    exports.diffSummaries = diffSummaries;
    exports.shouldDiffList = shouldDiffList;
    exports.apply = apply;
    return module.exports;
  }
});
`

await writeFile(outPath, bundle)
console.log(`built ${outPath}`)

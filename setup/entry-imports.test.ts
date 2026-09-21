import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// setup/ is outside every tsconfig, so an import of a name a module does not
// export is not a type error anywhere — it is a SyntaxError from Node's ESM
// loader at run time, on the operator's machine, one second into
// `nanoclaw.sh`. Vitest's own module runner does NOT enforce named exports
// (the broken import resolves to `undefined` and the test passes), so each
// entry is loaded in a real Node process, the way nanoclaw.sh loads it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadsUnderNode(entry: string): void {
  execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(path.join(root, entry))})`],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 },
  );
}

describe('setup entry points load under Node', () => {
  it('setup/auto.ts (the wizard)', () => expect(() => loadsUnderNode('setup/auto.ts')).not.toThrow());
  it('setup/verify.ts', () => expect(() => loadsUnderNode('setup/verify.ts')).not.toThrow());
  it('setup/lib/web-open.ts', () => expect(() => loadsUnderNode('setup/lib/web-open.ts')).not.toThrow());
});

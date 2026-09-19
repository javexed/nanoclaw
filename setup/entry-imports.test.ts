import { describe, expect, it } from 'vitest';

// setup/ is outside every tsconfig, so an import of a name a module does not
// export is not a type error anywhere — it is a SyntaxError at run time, on
// the operator's machine, one second into `nanoclaw.sh`. Loading the entry
// graphs here turns that into a failing test.
describe('setup entry points import', () => {
  it('auto.ts (the wizard) loads', async () => {
    await expect(import('./auto.js')).resolves.toBeDefined();
  });
  it('verify.ts loads', async () => {
    await expect(import('./verify.js')).resolves.toBeDefined();
  });
  it('lib/web-open.ts loads', async () => {
    await expect(import('./lib/web-open.js')).resolves.toBeDefined();
  });
});

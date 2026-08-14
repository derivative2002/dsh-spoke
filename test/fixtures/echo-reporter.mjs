// Test fixture: minimal custom reporter module. Records every report() call
// on a shared array so the test can assert the module-loading pathway.
export const seen = [];

export function createReporter(ctx) {
  return {
    name: 'echo-fixture',
    report(kind, payload) {
      seen.push({ cid: ctx.cid, kind, payload });
      return true;
    },
  };
}

// Minimal test runner for the plain-Node check scripts.
const cases = [];

export function test(name, fn) {
  cases.push({ name, fn });
}

export async function run(label) {
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`✗ ${name}\n  ${err.stack || err.message}`);
    }
  }
  if (failed) {
    console.error(`${label}: ${failed} of ${cases.length} tests failed.`);
    process.exit(1);
  }
  console.log(`${label}: ${cases.length} tests passed.`);
}

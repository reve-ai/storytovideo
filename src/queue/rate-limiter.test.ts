import { strict as assert } from 'node:assert';
import { RateLimiter } from './rate-limiter.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function testBasicAcquireRelease(): Promise<void> {
  const rl = new RateLimiter({ maxRPS: 10, maxConcurrent: 2 });
  try {
    await rl.acquire();
    const status = rl.getStatus();
    assert.equal(status.currentConcurrent, 1);
    rl.release();
    assert.equal(rl.getStatus().currentConcurrent, 0);
    console.log('  ✓ basic acquire/release');
  } finally {
    rl.destroy();
  }
}

async function testConcurrentLimit(): Promise<void> {
  const rl = new RateLimiter({ maxRPS: 100, maxConcurrent: 2 });
  try {
    await rl.acquire();
    await rl.acquire();
    // Third acquire should block
    let thirdAcquired = false;
    const thirdPromise = rl.acquire().then(() => { thirdAcquired = true; });
    await sleep(100);
    assert.equal(thirdAcquired, false, 'third acquire should be blocked');
    rl.release();
    await thirdPromise;
    assert.equal(thirdAcquired, true, 'third acquire should resolve after release');
    assert.equal(rl.getStatus().currentConcurrent, 2);
    rl.release();
    rl.release();
    console.log('  ✓ concurrent limit');
  } finally {
    rl.destroy();
  }
}

async function testTokenRateLimit(): Promise<void> {
  // 2 RPS means only 2 tokens available at start
  const rl = new RateLimiter({ maxRPS: 2, maxConcurrent: 100 });
  try {
    await rl.acquire();
    rl.release();
    await rl.acquire();
    rl.release();
    // Third should block until token refills
    let acquired = false;
    const acquirePromise = rl.acquire().then(() => { acquired = true; });
    await sleep(50);
    assert.equal(acquired, false, 'should be blocked waiting for token');
    // Wait for refill (at 2 RPS, ~500ms per token)
    await sleep(600);
    await acquirePromise;
    assert.equal(acquired, true, 'should have acquired after refill');
    rl.release();
    console.log('  ✓ token rate limit');
  } finally {
    rl.destroy();
  }
}

async function testBackoff(): Promise<void> {
  const rl = new RateLimiter({ maxRPS: 100, maxConcurrent: 10 });
  try {
    rl.backoff(300);
    const status = rl.getStatus();
    assert.equal(status.isBackingOff, true);
    assert.ok(status.backoffRemainingMs > 0);

    let acquired = false;
    const backoffPromise = rl.acquire().then(() => { acquired = true; });
    await sleep(100);
    assert.equal(acquired, false, 'should be blocked during backoff');
    await sleep(300);
    await backoffPromise;
    assert.equal(acquired, true, 'should acquire after backoff expires');
    rl.release();
    console.log('  ✓ backoff');
  } finally {
    rl.destroy();
  }
}

async function testAdaptiveBackoff(): Promise<void> {
  const rl = new RateLimiter({
    maxRPS: 100,
    maxConcurrent: 10,
    maxBackoffMs: 10_000,
    adaptiveWindowMs: 5_000,
  });
  try {
    // First backoff: 200ms
    rl.backoff(200);
    await sleep(250);

    // Second backoff within window: should double to at least 400ms
    rl.backoff(200);
    const status = rl.getStatus();
    assert.ok(
      status.backoffRemainingMs > 250,
      `adaptive backoff should be > 250ms, got ${status.backoffRemainingMs}`
    );
    console.log('  ✓ adaptive backoff');
  } finally {
    rl.destroy();
  }
}

async function testMultipleConcurrentAcquires(): Promise<void> {
  const rl = new RateLimiter({ maxRPS: 50, maxConcurrent: 3 });
  try {
    const results: number[] = [];
    const workers = Array.from({ length: 5 }, (_, i) =>
      rl.acquire().then(() => {
        results.push(i);
        // Simulate work then release
        return sleep(50).then(() => rl.release());
      })
    );
    await Promise.all(workers);
    assert.equal(results.length, 5, 'all 5 workers should complete');
    console.log('  ✓ multiple concurrent acquires');
  } finally {
    rl.destroy();
  }
}

async function testGetStatus(): Promise<void> {
  const rl = new RateLimiter({ maxRPS: 10, maxConcurrent: 5 });
  try {
    const s = rl.getStatus();
    assert.equal(typeof s.availableTokens, 'number');
    assert.equal(s.currentConcurrent, 0);
    assert.equal(s.isBackingOff, false);
    assert.equal(s.backoffRemainingMs, 0);
    console.log('  ✓ getStatus');
  } finally {
    rl.destroy();
  }
}

async function main(): Promise<void> {
  console.log('RateLimiter tests:');
  await testBasicAcquireRelease();
  await testConcurrentLimit();
  await testTokenRateLimit();
  await testBackoff();
  await testAdaptiveBackoff();
  await testMultipleConcurrentAcquires();
  await testGetStatus();
  console.log('\nAll tests passed ✓');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


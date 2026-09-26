/** 按 bucket 串行写 Redis，避免 B/C 并发 read-modify-write 丢字段 */
const chains = {};

function withBucketWrite(bucketName, fn) {
  const prev = chains[bucketName] || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  chains[bucketName] = run.then(
    () => {},
    () => {},
  );
  return run;
}

module.exports = { withBucketWrite };

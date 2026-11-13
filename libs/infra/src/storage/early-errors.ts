/**
 * A Node stream (e.g. `createReadStream` of a file that does not exist) can emit `error` before the adapter starts
 * reading it — during an `await` in between. Without a listener that error is uncaught and kills the process
 * (the worker crashed this way on a missing sprite sheet, 2026-11-13). Listen from the first moment and hand the
 * error back as a normal rejection.
 */
export function watchEarlyErrors(body: unknown): { check: () => void; stop: () => void } {
  const stream = body as { once?: unknown; off?: unknown };
  let early: unknown;
  const onError = (err: unknown) => {
    early ??= err;
  };
  const isEmitter = typeof stream.once === 'function' && typeof stream.off === 'function';
  if (isEmitter) (stream as NodeJS.EventEmitter).once('error', onError);
  return {
    check: () => {
      if (early !== undefined) throw early;
    },
    stop: () => {
      if (isEmitter) (stream as NodeJS.EventEmitter).off('error', onError);
    },
  };
}

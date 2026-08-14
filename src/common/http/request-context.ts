import { AsyncLocalStorage } from 'async_hooks';

type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

/** Returns the current request's id, or undefined outside of a request (e.g. a cron job
 * invoked directly, or app startup) - callers should treat a missing id as normal, not an
 * error. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

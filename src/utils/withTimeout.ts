/**
 * Settles with `work`, or rejects with `timeoutError()` after `ms`, whichever comes first.
 * Use it where the awaited call takes no AbortSignal (e.g. Temporal handles, Redis commands).
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), ms);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // The losing promise may still reject later; it must not surface as unhandled.
    work.catch(() => undefined);
  }
}

/**
 * Retry utility with exponential backoff for transient failures
 *
 * @module utils/retry
 */

import { logger } from './logger';
import { isRetryableError } from '../types/error-types';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;

  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number;

  /** Maximum delay in milliseconds (default: 30000 / 30s) */
  maxDelay?: number;

  /** Backoff strategy (default: 'exponential') */
  backoff?: 'exponential' | 'linear' | 'constant';

  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;

  /** Whether to add random jitter to prevent thundering herd (default: true) */
  jitter?: boolean;

  /** Custom function to determine if error is retryable (default: uses isRetryableError) */
  shouldRetry?: (error: Error, attempt: number) => boolean;

  /** Callback called before each retry */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;

  /** Callback called when all retries are exhausted */
  onExhausted?: (error: Error, attempts: number) => void;

  /** Operation name for logging (optional) */
  operationName?: string;
}

export interface RetryResult<T> {
  success: boolean;
  value?: T;
  error?: Error;
  attempts: number;
  totalTime: number;
}

/**
 * Default retry options
 */
const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'shouldRetry' | 'onRetry' | 'onExhausted' | 'operationName'>> = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential',
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Calculate delay for next retry attempt
 */
function calculateDelay(
  attempt: number,
  options: Required<Omit<RetryOptions, 'shouldRetry' | 'onRetry' | 'onExhausted' | 'operationName'>>
): number {
  let delay: number;

  switch (options.backoff) {
    case 'exponential':
      delay = options.initialDelay * Math.pow(options.backoffMultiplier, attempt - 1);
      break;

    case 'linear':
      delay = options.initialDelay * attempt;
      break;

    case 'constant':
      delay = options.initialDelay;
      break;
  }

  // Cap at max delay
  delay = Math.min(delay, options.maxDelay);

  // Add jitter (0-25% random variation)
  if (options.jitter) {
    const jitterAmount = delay * 0.25 * Math.random();
    delay += jitterAmount;
  }

  return Math.floor(delay);
}

/**
 * Wait for specified milliseconds
 */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic
 *
 * @example
 * ```typescript
 * // Simple retry with defaults
 * const result = await withRetry(() => fetchData());
 *
 * // Custom retry options
 * const result = await withRetry(
 *   () => callExternalAPI(),
 *   {
 *     maxAttempts: 5,
 *     initialDelay: 2000,
 *     backoff: 'exponential',
 *     operationName: 'External API Call'
 *   }
 * );
 *
 * // With custom retry logic
 * const result = await withRetry(
 *   () => saveToDatabase(),
 *   {
 *     shouldRetry: (error) => error.message.includes('deadlock'),
 *     maxAttempts: 10
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const result = await fn();

      if (attempt > 1 && opts.operationName) {
        logger.info(`${opts.operationName} succeeded after ${attempt} attempts`);
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Determine if we should retry
      const shouldRetry = options.shouldRetry
        ? options.shouldRetry(lastError, attempt)
        : isRetryableError(lastError);

      // If this was the last attempt or error is not retryable, throw
      if (attempt >= opts.maxAttempts || !shouldRetry) {
        if (options.onExhausted) {
          options.onExhausted(lastError, attempt);
        }

        if (opts.operationName) {
          logger.error(`${opts.operationName} failed after ${attempt} attempts`, {
            error: lastError.message,
            totalTime: Date.now() - startTime
          });
        }

        throw lastError;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, opts);

      if (options.onRetry) {
        options.onRetry(lastError, attempt, delay);
      }

      if (opts.operationName) {
        logger.warn(`${opts.operationName} attempt ${attempt} failed, retrying in ${delay}ms`, {
          error: lastError.message
        });
      }

      await wait(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('Retry failed with unknown error');
}

/**
 * Execute a function with retry logic and return detailed result
 *
 * Unlike withRetry(), this doesn't throw on failure - it returns a result object
 */
export async function tryWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const startTime = Date.now();
  let attempts = 0;

  try {
    const value = await withRetry(fn, {
      ...options,
      onRetry: (error, attempt, delay) => {
        attempts = attempt;
        options.onRetry?.(error, attempt, delay);
      }
    });

    return {
      success: true,
      value,
      attempts: attempts + 1,
      totalTime: Date.now() - startTime
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
      attempts: options.maxAttempts || DEFAULT_OPTIONS.maxAttempts,
      totalTime: Date.now() - startTime
    };
  }
}

/**
 * Retry decorator for class methods
 *
 * @example
 * ```typescript
 * class APIClient {
 *   @Retry({ maxAttempts: 5 })
 *   async fetchData() {
 *     return await this.http.get('/data');
 *   }
 * }
 * ```
 */
export function Retry(options: RetryOptions = {}) {
  return function (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      return withRetry(
        () => originalMethod.apply(this, args),
        { ...options, operationName: propertyKey }
      );
    };

    return descriptor;
  };
}

/**
 * Create a retryable version of any async function
 *
 * @example
 * ```typescript
 * const retryableFetch = retryable(
 *   (url: string) => fetch(url),
 *   { maxAttempts: 5 }
 * );
 *
 * const response = await retryableFetch('https://api.example.com/data');
 * ```
 */
export function retryable<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    return withRetry(() => fn(...args), options);
  };
}

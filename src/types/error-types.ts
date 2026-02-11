/**
 * Standardized Error Type Hierarchy
 *
 * Provides a consistent error handling framework across the codebase
 * with context tracking, retry support, and actionable error messages.
 *
 * Usage:
 *   throw new NetworkError('Failed to connect to API', { url: apiUrl });
 *   throw new ValidationError('Invalid email format', { field: 'email', value });
 *   throw new RateLimitError('Too many requests', { retryAfter: 60 });
 */

export interface ErrorContext {
  [key: string]: unknown;
}

/**
 * Base error class with context tracking and retry support
 */
export class ApplicationError extends Error {
  public readonly timestamp: Date;
  public readonly code: string;
  public readonly context?: ErrorContext;
  public readonly retryable: boolean;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    context?: ErrorContext,
    retryable: boolean = false,
    cause?: Error
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.context = context;
    this.retryable = retryable;
    this.cause = cause;
    this.timestamp = new Date();

    // Maintains proper stack trace (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Get a user-friendly error message
   */
  getUserMessage(): string {
    return this.message;
  }

  /**
   * Get complete error details for logging
   */
  getDetails(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      timestamp: this.timestamp.toISOString(),
      retryable: this.retryable,
      context: this.context,
      cause: this.cause?.message,
      stack: this.stack,
    };
  }

  /**
   * Convert to JSON for API responses
   */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        timestamp: this.timestamp.toISOString(),
        retryable: this.retryable,
        context: this.context,
      },
    };
  }
}

/**
 * Network-related errors (connection failures, timeouts, DNS)
 * These are typically retryable with exponential backoff
 */
export class NetworkError extends ApplicationError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, 'NETWORK_ERROR', context, true, cause);
    this.name = 'NetworkError';
  }

  getUserMessage(): string {
    return `Network error: ${this.message}. Please check your connection and try again.`;
  }

  static connectionRefused(url: string, cause?: Error): NetworkError {
    return new NetworkError(
      'Connection refused',
      { url, action: 'Verify that the service is running and accessible' },
      cause
    );
  }

  static timeout(url: string, timeout: number, cause?: Error): NetworkError {
    return new NetworkError(
      'Request timeout',
      { url, timeout, action: 'Try increasing the timeout or check service health' },
      cause
    );
  }

  static dnsLookupFailed(hostname: string, cause?: Error): NetworkError {
    return new NetworkError(
      'DNS lookup failed',
      { hostname, action: 'Check hostname spelling and DNS configuration' },
      cause
    );
  }
}

/**
 * Validation errors (invalid input, schema violations)
 * These are NOT retryable - input must be corrected
 */
export class ValidationError extends ApplicationError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, 'VALIDATION_ERROR', context, false, cause);
    this.name = 'ValidationError';
  }

  getUserMessage(): string {
    const field = this.context?.field ? ` (${this.context.field})` : '';
    return `Validation error${field}: ${this.message}`;
  }

  static required(field: string): ValidationError {
    return new ValidationError(
      `${field} is required`,
      { field, action: `Provide a value for ${field}` }
    );
  }

  static invalidFormat(field: string, expected: string): ValidationError {
    return new ValidationError(
      `Invalid format for ${field}`,
      { field, expected, action: `Provide ${field} in the format: ${expected}` }
    );
  }

  static outOfRange(field: string, min?: number, max?: number): ValidationError {
    const range = min !== undefined && max !== undefined
      ? `between ${min} and ${max}`
      : min !== undefined
      ? `at least ${min}`
      : `at most ${max}`;
    return new ValidationError(
      `${field} must be ${range}`,
      { field, min, max, action: `Provide a value ${range}` }
    );
  }

  static invalidEnum(field: string, value: unknown, allowedValues: string[]): ValidationError {
    return new ValidationError(
      `Invalid value for ${field}`,
      {
        field,
        value,
        allowedValues,
        action: `Use one of: ${allowedValues.join(', ')}`,
      }
    );
  }
}

/**
 * Authentication errors (invalid credentials, expired tokens)
 * These are NOT retryable - credentials must be updated
 */
export class AuthenticationError extends ApplicationError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, 'AUTHENTICATION_ERROR', context, false, cause);
    this.name = 'AuthenticationError';
  }

  getUserMessage(): string {
    return `Authentication failed: ${this.message}. Please check your credentials.`;
  }

  static invalidApiKey(service?: string): AuthenticationError {
    return new AuthenticationError(
      'Invalid API key',
      {
        service,
        action: 'Verify your API key is correct and has not expired',
      }
    );
  }

  static tokenExpired(): AuthenticationError {
    return new AuthenticationError(
      'Authentication token expired',
      { action: 'Refresh your authentication token' }
    );
  }

  static insufficientPermissions(required: string[]): AuthenticationError {
    return new AuthenticationError(
      'Insufficient permissions',
      {
        required,
        action: `Ensure your credentials have these permissions: ${required.join(', ')}`,
      }
    );
  }
}

/**
 * Rate limit errors (too many requests)
 * These are retryable after the specified delay
 */
export class RateLimitError extends ApplicationError {
  public readonly retryAfter?: number;
  public readonly limit?: number;
  public readonly remaining?: number;
  public readonly resetAt?: Date;

  constructor(
    message: string,
    context?: ErrorContext & {
      retryAfter?: number;
      limit?: number;
      remaining?: number;
      resetAt?: Date;
    },
    cause?: Error
  ) {
    super(message, 'RATE_LIMIT_ERROR', context, true, cause);
    this.name = 'RateLimitError';
    this.retryAfter = context?.retryAfter;
    this.limit = context?.limit;
    this.remaining = context?.remaining;
    this.resetAt = context?.resetAt;
  }

  getUserMessage(): string {
    if (this.retryAfter) {
      return `Rate limit exceeded. Please retry after ${this.retryAfter} seconds.`;
    }
    if (this.resetAt) {
      return `Rate limit exceeded. Limit resets at ${this.resetAt.toLocaleString()}.`;
    }
    return `Rate limit exceeded. Please retry later.`;
  }

  static fromHeaders(headers: Record<string, string>): RateLimitError {
    const retryAfter = headers['retry-after']
      ? parseInt(headers['retry-after'])
      : undefined;
    const limit = headers['x-rate-limit-limit']
      ? parseInt(headers['x-rate-limit-limit'])
      : undefined;
    const remaining = headers['x-rate-limit-remaining']
      ? parseInt(headers['x-rate-limit-remaining'])
      : undefined;
    const reset = headers['x-rate-limit-reset']
      ? new Date(parseInt(headers['x-rate-limit-reset']) * 1000)
      : undefined;

    return new RateLimitError(
      'Rate limit exceeded',
      {
        retryAfter,
        limit,
        remaining,
        resetAt: reset,
        action: retryAfter
          ? `Wait ${retryAfter} seconds before retrying`
          : 'Wait before retrying',
      }
    );
  }
}

/**
 * Configuration errors (missing env vars, invalid config)
 * These are NOT retryable - configuration must be fixed
 */
export class ConfigurationError extends ApplicationError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, 'CONFIGURATION_ERROR', context, false, cause);
    this.name = 'ConfigurationError';
  }

  getUserMessage(): string {
    return `Configuration error: ${this.message}`;
  }

  static missingEnvVar(varName: string): ConfigurationError {
    return new ConfigurationError(
      `Missing required environment variable: ${varName}`,
      {
        variable: varName,
        action: `Set the ${varName} environment variable`,
      }
    );
  }

  static invalidConfig(key: string, value: unknown, expected: string): ConfigurationError {
    return new ConfigurationError(
      `Invalid configuration for ${key}`,
      {
        key,
        value,
        expected,
        action: `Update configuration: ${key} should be ${expected}`,
      }
    );
  }
}

/**
 * Resource not found errors (404)
 * These are typically NOT retryable unless the resource is expected to be created
 */
export class NotFoundError extends ApplicationError {
  constructor(
    message: string,
    context?: ErrorContext,
    retryable: boolean = false,
    cause?: Error
  ) {
    super(message, 'NOT_FOUND_ERROR', context, retryable, cause);
    this.name = 'NotFoundError';
  }

  getUserMessage(): string {
    return `Resource not found: ${this.message}`;
  }

  static resource(resourceType: string, id: string): NotFoundError {
    return new NotFoundError(
      `${resourceType} not found`,
      {
        resourceType,
        id,
        action: `Verify that ${resourceType} with ID ${id} exists`,
      }
    );
  }

  static endpoint(path: string, method: string): NotFoundError {
    return new NotFoundError(
      'Endpoint not found',
      {
        path,
        method,
        action: 'Check the API documentation for the correct endpoint',
      }
    );
  }
}

/**
 * External service errors (third-party API failures)
 * Retryability depends on the status code
 */
export class ExternalServiceError extends ApplicationError {
  public readonly service: string;
  public readonly statusCode?: number;

  constructor(
    message: string,
    service: string,
    context?: ErrorContext & { statusCode?: number },
    retryable: boolean = true,
    cause?: Error
  ) {
    super(message, 'EXTERNAL_SERVICE_ERROR', context, retryable, cause);
    this.name = 'ExternalServiceError';
    this.service = service;
    this.statusCode = context?.statusCode;
  }

  getUserMessage(): string {
    return `${this.service} error: ${this.message}`;
  }

  static fromHttpResponse(
    service: string,
    statusCode: number,
    responseBody?: unknown
  ): ExternalServiceError {
    const retryable = statusCode >= 500 || statusCode === 429;
    const message = statusCode >= 500
      ? `${service} is experiencing issues`
      : `Request to ${service} failed with status ${statusCode}`;

    return new ExternalServiceError(
      message,
      service,
      {
        statusCode,
        responseBody,
        action: retryable ? 'This is a temporary issue - retry shortly' : 'Check request parameters',
      },
      retryable
    );
  }
}

/**
 * Database errors (connection, query failures)
 * Some are retryable (deadlocks, timeouts), others are not (constraint violations)
 */
export class DatabaseError extends ApplicationError {
  constructor(
    message: string,
    context?: ErrorContext,
    retryable: boolean = false,
    cause?: Error
  ) {
    super(message, 'DATABASE_ERROR', context, retryable, cause);
    this.name = 'DatabaseError';
  }

  getUserMessage(): string {
    return `Database error: ${this.message}`;
  }

  static connectionFailed(database: string, cause?: Error): DatabaseError {
    return new DatabaseError(
      'Database connection failed',
      {
        database,
        action: 'Check database connection settings and ensure the database is running',
      },
      true,
      cause
    );
  }

  static queryFailed(query: string, cause?: Error): DatabaseError {
    return new DatabaseError(
      'Query execution failed',
      { query: query.substring(0, 100), action: 'Check query syntax and parameters' },
      false,
      cause
    );
  }

  static deadlock(cause?: Error): DatabaseError {
    return new DatabaseError(
      'Deadlock detected',
      { action: 'Transaction will be retried automatically' },
      true,
      cause
    );
  }
}

/**
 * Operation timeout errors
 * These are typically retryable
 */
export class TimeoutError extends ApplicationError {
  public readonly timeout: number;

  constructor(message: string, timeout: number, context?: ErrorContext, cause?: Error) {
    super(message, 'TIMEOUT_ERROR', { ...context, timeout }, true, cause);
    this.name = 'TimeoutError';
    this.timeout = timeout;
  }

  getUserMessage(): string {
    return `Operation timed out after ${this.timeout}ms: ${this.message}`;
  }

  static operationTimeout(operation: string, timeout: number): TimeoutError {
    return new TimeoutError(
      `${operation} timed out`,
      timeout,
      {
        operation,
        action: 'Try increasing the timeout or check if the service is responding',
      }
    );
  }
}

/**
 * Type guard to check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof ApplicationError && error.retryable;
}

/**
 * Type guard to check if error is an ApplicationError
 */
export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}

/**
 * Extract error message safely from any error type
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApplicationError) {
    return error.getUserMessage();
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unknown error occurred';
}

/**
 * Extract error code safely from any error type
 */
export function getErrorCode(error: unknown): string {
  if (error instanceof ApplicationError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return 'UNKNOWN_ERROR';
}

/**
 * Performance tracking decorators for monitoring critical operations
 */

import { monitoring, OperationMetric, DatabaseQueryMetric } from './monitoring';
import { logger } from '../utils/logger';

/**
 * Decorator to track performance of any method
 */
export function trackPerformance(operationName?: string, includeArgs = false) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    const opName = operationName || `${target.constructor.name}.${propertyName}`;

    descriptor.value = async function (...args: any[]) {
      const startTime = Date.now();
      let success = true;
      let errorCode: string | undefined;
      let errorMessage: string | undefined;

      try {
        const result = await method.apply(this, args);
        
        monitoring.recordOperation({
          operation: opName,
          duration: Date.now() - startTime,
          success: true,
          metadata: includeArgs ? { args: sanitizeArgs(args) } : undefined,
        });

        return result;
      } catch (error) {
        success = false;
        errorCode = error instanceof Error ? error.constructor.name : 'UnknownError';
        errorMessage = error instanceof Error ? error.message : String(error);

        monitoring.recordOperation({
          operation: opName,
          duration: Date.now() - startTime,
          success: false,
          errorCode,
          errorMessage,
          metadata: includeArgs ? { args: sanitizeArgs(args) } : undefined,
        });

        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Decorator specifically for database operations
 */
export function trackDatabaseQuery(queryType?: string) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const startTime = Date.now();
      let rowCount: number | undefined;
      let indexUsed: string | undefined;

      try {
        // For database methods, we need to extract SQL query
        const sqlQuery = extractQueryFromArgs(args);
        if (sqlQuery) {
          indexUsed = detectIndexUsage(sqlQuery);
        }

        const result = await method.apply(this, args);

        // Extract row count based on result type
        if (Array.isArray(result)) {
          rowCount = result.length;
        } else if (result && typeof result === 'object' && 'length' in result) {
          rowCount = (result as { length: number }).length;
        }

        const duration = Date.now() - startTime;

        if (sqlQuery) {
          monitoring.recordDatabaseQuery({
            query: sqlQuery,
            duration,
            rowCount,
            index: indexUsed,
            tags: {
              query_type: queryType || 'unknown',
              method: propertyName,
            },
          });
        }

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        const sqlQuery = extractQueryFromArgs(args);

        if (sqlQuery) {
          monitoring.recordDatabaseQuery({
            query: sqlQuery,
            duration,
            rowCount,
            index: indexUsed,
            tags: {
              query_type: queryType || 'unknown',
              method: propertyName,
              error: error instanceof Error ? error.constructor.name : 'UnknownError',
            },
          });
        }

        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Higher-order function for tracking performance without decorators
 */
export function withPerformanceTracking<T extends unknown[], R>(
  operationName: string,
  fn: (...args: T) => Promise<R>,
  options: { includeArgs?: boolean; tags?: Record<string, string> } = {}
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    const startTime = Date.now();
    let success = true;
    let errorCode: string | undefined;
    let errorMessage: string | undefined;

    try {
      monitoring.addBreadcrumb(`Starting ${operationName}`, 'info', 'operation', options.tags);
      
      const result = await fn(...args);
      const duration = Date.now() - startTime;

      monitoring.recordOperation({
        operation: operationName,
        duration,
        success: true,
        metadata: options.includeArgs ? { args: sanitizeArgs(args) } : undefined,
      });

      monitoring.addBreadcrumb(`Completed ${operationName}`, 'info', 'operation', {
        duration: `${duration}ms`,
        ...options.tags,
      });

      return result;
    } catch (error) {
      success = false;
      errorCode = error instanceof Error ? error.constructor.name : 'UnknownError';
      errorMessage = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - startTime;

      monitoring.recordOperation({
        operation: operationName,
        duration,
        success: false,
        errorCode,
        errorMessage,
        metadata: options.includeArgs ? { args: sanitizeArgs(args) } : undefined,
      });

      monitoring.addBreadcrumb(`Failed ${operationName}`, 'error', 'operation', {
        duration: `${duration}ms`,
        error: errorMessage,
        ...options.tags,
      });

      throw error;
    }
  };
}

/**
 * Track template fetching performance specifically
 */
export function trackTemplateFetch(operationName: string = 'template_fetch') {
  return withPerformanceTracking(operationName, async (templateId?: string, options?: Record<string, unknown>) => {
    // This is a placeholder - the actual implementation would depend on how templates are fetched
    logger.debug(`Fetching template: ${templateId}`, { options });
    
    // The actual template fetching logic would be passed in as a function
    throw new Error('trackTemplateFetch must be used with a specific fetch function');
  });
}

/**
 * Track MCP tool execution performance
 */
export function trackMcpTool(toolName: string) {
  return withPerformanceTracking(`mcp_tool_${toolName}`, async (args: Record<string, unknown>) => {
    logger.debug(`Executing MCP tool: ${toolName}`, { args });
    
    // The actual tool execution logic would be passed in as a function
    throw new Error('trackMcpTool must be used with a specific tool function');
  });
}

/**
 * Extract SQL query from method arguments
 */
function extractQueryFromArgs(args: unknown[]): string | null {
  if (args.length === 0) return null;
  
  // First argument is often the SQL query string
  if (typeof args[0] === 'string' && isSQLQuery(args[0])) {
    return args[0];
  }
  
  // Sometimes query is in an object
  if (typeof args[0] === 'object' && args[0] !== null) {
    if (typeof args[0].sql === 'string' && isSQLQuery(args[0].sql)) {
      return args[0].sql;
    }
    if (typeof args[0].query === 'string' && isSQLQuery(args[0].query)) {
      return args[0].query;
    }
  }
  
  return null;
}

/**
 * Check if a string looks like an SQL query
 */
function isSQLQuery(str: string): boolean {
  const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'WITH'];
  const upperStr = str.trim().toUpperCase();
  
  return sqlKeywords.some(keyword => upperStr.startsWith(keyword + ' ') || upperStr.startsWith(keyword + '\n'));
}

/**
 * Simple index usage detection based on query patterns
 */
function detectIndexUsage(query: string): string | undefined {
  const upperQuery = query.toUpperCase();
  
  // Check for WHERE clauses that might use indexes
  if (upperQuery.includes('WHERE')) {
    // Look for common indexed columns
    const indexedColumns = ['id', 'node_type', 'package_name', 'created_at', 'is_ai_tool'];
    
    for (const col of indexedColumns) {
      if (upperQuery.includes(`WHERE ${col}`) || upperQuery.includes(`WHERE ${col}`)) {
        return `idx_${col}`;
      }
    }
  }
  
  // Check for explicit index hints (MySQL style)
  if (upperQuery.includes('USE INDEX') || upperQuery.includes('FORCE INDEX')) {
    const match = upperQuery.match(/(?:USE|FORCE) INDEX\s*\(([^)]+)\)/i);
    return match ? match[1].trim() : undefined;
  }
  
  return undefined;
}

/**
 * Sanitize arguments to remove sensitive information
 */
function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map(arg => {
    if (typeof arg === 'string' && arg.length > 100) {
      return arg.substring(0, 100) + '...';
    }
    
    if (typeof arg === 'object' && arg !== null) {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(arg)) {
        // Skip potential sensitive fields
        if (['password', 'token', 'secret', 'key', 'auth'].some(sensitive => 
          key.toLowerCase().includes(sensitive)
        )) {
          sanitized[key] = '[REDACTED]';
        } else if (typeof value === 'string' && value.length > 100) {
          sanitized[key] = value.substring(0, 100) + '...';
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }
    
    return arg;
  });
}

/**
 * Start automatic memory monitoring
 */
export function startMemoryMonitoring(intervalMs: number = 30000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      monitoring.recordMemoryUsage();
    } catch (error) {
      logger.error('Failed to record memory usage', { error });
    }
  }, intervalMs);
}

/**
 * Performance monitoring utilities
 */
export const performanceUtils = {
  /**
   * Create a performance timer for manual tracking
   */
  startTimer(operationName: string): {
    end(additionalData?: Record<string, any>): number;
  } {
    const startTime = Date.now();
    
    return {
      end(additionalData?: Record<string, any>): number {
        const duration = Date.now() - startTime;
        
        monitoring.recordOperation({
          operation: operationName,
          duration,
          success: true,
          metadata: additionalData,
        });
        
        return duration;
      },
    };
  },
  
  /**
   * Measure function execution time
   */
  async measure<T>(
    operationName: string,
    fn: () => Promise<T>,
    additionalData?: Record<string, any>
  ): Promise<T> {
    const timer = performanceUtils.startTimer(operationName);
    
    try {
      const result = await fn();
      timer.end(additionalData);
      return result;
    } catch (error) {
      timer.end({
        ...additionalData,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
};
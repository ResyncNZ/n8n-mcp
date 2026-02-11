/**
 * Database Performance Monitor
 * Wraps database operations with performance tracking and query optimization monitoring
 */

import { logger } from '../utils/logger';
import { monitoring } from '../monitoring/monitoring';
import type { DatabaseAdapter, PreparedStatement } from '../database/database-adapter';
import type { DatabaseRow, SqlParameter } from '../types/database-types';

interface QueryPerformanceMetrics {
  queryType: string;
  table?: string;
  hasWhere: boolean;
  hasIndex: boolean;
  estimatedRows: number;
  actualRows?: number;
}

export class DatabasePerformanceMonitor implements DatabaseAdapter {
  private wrapped: DatabaseAdapter;
  private slowQueryThreshold = 1000; // 1 second

  constructor(wrapped: DatabaseAdapter) {
    this.wrapped = wrapped;
  }

  /**
   * Wrap prepared statement with performance monitoring
   */
  prepare(sql: string): PreparedStatement {
    const startTime = performance.now();
    const queryMetrics = this.analyzeQuery(sql);

    return new MonitoredPreparedStatement(
      this.wrapped.prepare(sql),
      sql,
      queryMetrics,
      startTime
    );
  }

  /**
   * Wrap exec with performance monitoring
   */
  exec(sql: string): void {
    const startTime = performance.now();
    const queryMetrics = this.analyzeQuery(sql);

    try {
      this.wrapped.exec(sql);
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: sql,
        duration,
        rowCount: undefined,
        tags: {
          query_type: queryMetrics.queryType,
          table: queryMetrics.table || 'unknown',
          has_where: queryMetrics.hasWhere.toString(),
          has_index: queryMetrics.hasIndex.toString(),
        },
      });
    } catch (error) {
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: sql,
        duration,
        rowCount: 0,
        tags: {
          query_type: queryMetrics.queryType,
          table: queryMetrics.table || 'unknown',
          error: 'true',
        },
      });

      throw error;
    }
  }

  close(): void {
    this.wrapped.close();
  }

  pragma(key: string, value?: any): any {
    return this.wrapped.pragma(key, value);
  }

  get inTransaction(): boolean {
    return this.wrapped.inTransaction;
  }

  transaction<T>(fn: () => T): T {
    const transactionStart = performance.now();

    try {
      const result = this.wrapped.transaction(fn);
      const duration = performance.now() - transactionStart;

      monitoring.recordMetric({
        name: 'database_transaction_duration',
        value: duration,
        unit: 'milliseconds',
        tags: { success: 'true' },
      });

      return result;
    } catch (error) {
      const duration = performance.now() - transactionStart;

      monitoring.recordMetric({
        name: 'database_transaction_duration',
        value: duration,
        unit: 'milliseconds',
        tags: { success: 'false' },
      });

      throw error;
    }
  }

  checkFTS5Support(): boolean {
    return this.wrapped.checkFTS5Support();
  }

  /**
   * Analyze SQL query to extract performance-relevant information
   */
  private analyzeQuery(sql: string): QueryPerformanceMetrics {
    const normalizedSql = sql.trim().toLowerCase();
    
    // Determine query type
    let queryType = 'unknown';
    if (normalizedSql.startsWith('select')) {
      queryType = 'select';
    } else if (normalizedSql.startsWith('insert')) {
      queryType = 'insert';
    } else if (normalizedSql.startsWith('update')) {
      queryType = 'update';
    } else if (normalizedSql.startsWith('delete')) {
      queryType = 'delete';
    } else if (normalizedSql.startsWith('create')) {
      queryType = 'create';
    } else if (normalizedSql.startsWith('pragma')) {
      queryType = 'pragma';
    }

    // Extract table name (simple extraction)
    const tableMatch = sql.match(/\bfrom\s+(\w+)|\binto\s+(\w+)|\bupdate\s+(\w+)|\btable\s+(\w+)/i);
    const table = tableMatch ? (tableMatch[1] || tableMatch[2] || tableMatch[3] || tableMatch[4]) : undefined;

    // Check for WHERE clause
    const hasWhere = /\bwhere\b/i.test(sql);

    // Simple index detection - this would be more sophisticated with EXPLAIN QUERY PLAN
    const hasIndex = hasWhere && /\bindexed\s+by\b/i.test(sql);

    return {
      queryType,
      table,
      hasWhere,
      hasIndex,
      estimatedRows: this.estimateRowCount(sql, queryType),
    };
  }

  /**
   * Simple row count estimation based on query type
   */
  private estimateRowCount(sql: string, queryType: string): number {
    switch (queryType) {
      case 'select':
        // Look for LIMIT clause
        const limitMatch = sql.match(/\blimit\s+(\d+)/i);
        if (limitMatch) {
          return parseInt(limitMatch[1], 10);
        }
        // Estimate based on query complexity
        return /\bwhere\b/i.test(sql) ? 10 : 100;
      case 'insert':
        return 1;
      case 'update':
      case 'delete':
        // Could be multiple rows with WHERE clause
        return /\bwhere\b/i.test(sql) ? 5 : 50;
      default:
        return 1;
    }
  }
}

/**
 * Monitored prepared statement that tracks query performance
 */
class MonitoredPreparedStatement implements PreparedStatement {
  private wrapped: PreparedStatement;
  private sql: string;
  private queryMetrics: QueryPerformanceMetrics;
  private prepareTime: number;

  constructor(
    wrapped: PreparedStatement,
    sql: string,
    queryMetrics: QueryPerformanceMetrics,
    prepareTime: number
  ) {
    this.wrapped = wrapped;
    this.sql = sql;
    this.queryMetrics = queryMetrics;
    this.prepareTime = prepareTime;
  }

  run(...params: SqlParameter[]): { changes: number; lastInsertRowid: number | bigint } {
    const startTime = performance.now();

    try {
      const result = this.wrapped.run(...params);
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: this.sql,
        duration,
        rowCount: result.changes,
        tags: {
          query_type: this.queryMetrics.queryType,
          table: this.queryMetrics.table || 'unknown',
          has_where: this.queryMetrics.hasWhere.toString(),
          has_index: this.queryMetrics.hasIndex.toString(),
          operation: 'run',
          params_count: params.length.toString(),
        },
      });

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: this.sql,
        duration,
        rowCount: 0,
        tags: {
          query_type: this.queryMetrics.queryType,
          table: this.queryMetrics.table || 'unknown',
          error: 'true',
          operation: 'run',
        },
      });

      throw error;
    }
  }

  get(...params: SqlParameter[]): DatabaseRow | undefined {
    const startTime = performance.now();

    try {
      const result = this.wrapped.get(...params);
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: this.sql,
        duration,
        rowCount: result ? 1 : 0,
        tags: {
          query_type: this.queryMetrics.queryType,
          table: this.queryMetrics.table || 'unknown',
          has_where: this.queryMetrics.hasWhere.toString(),
          has_index: this.queryMetrics.hasIndex.toString(),
          operation: 'get',
          found_result: (result !== undefined).toString(),
        },
      });

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: this.sql,
        duration,
        rowCount: 0,
        tags: {
          query_type: this.queryMetrics.queryType,
          table: this.queryMetrics.table || 'unknown',
          error: 'true',
          operation: 'get',
        },
      });

      throw error;
    }
  }

  all(...params: SqlParameter[]): DatabaseRow[] {
    const startTime = performance.now();

    try {
      const result = this.wrapped.all(...params);
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: this.sql,
        duration,
        rowCount: result.length,
        tags: {
          query_type: this.queryMetrics.queryType,
          table: this.queryMetrics.table || 'unknown',
          has_where: this.queryMetrics.hasWhere.toString(),
          has_index: this.queryMetrics.hasIndex.toString(),
          operation: 'all',
        },
      });

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;

      monitoring.recordDatabaseQuery({
        query: this.sql,
        duration,
        rowCount: 0,
        tags: {
          query_type: this.queryMetrics.queryType,
          table: this.queryMetrics.table || 'unknown',
          error: 'true',
          operation: 'all',
        },
      });

      throw error;
    }
  }

  iterate(...params: SqlParameter[]): IterableIterator<DatabaseRow> {
    // For iterators, we can't easily track the entire iteration time
    // So we'll track when the iterator is created
    monitoring.recordDatabaseQuery({
      query: this.sql,
      duration: 0, // Placeholder
      rowCount: undefined,
      tags: {
        query_type: this.queryMetrics.queryType,
        table: this.queryMetrics.table || 'unknown',
        operation: 'iterate',
      },
    });

    return this.wrapped.iterate(...params);
  }

  pluck(toggle?: boolean): this {
    this.wrapped.pluck(toggle);
    return this;
  }

  expand(toggle?: boolean): this {
    this.wrapped.expand(toggle);
    return this;
  }

  raw(toggle?: boolean): this {
    this.wrapped.raw(toggle);
    return this;
  }

  columns(): Array<{ name: string; column: string | null; table: string | null; database: string | null; type: string | null }> {
    return this.wrapped.columns();
  }

  bind(...params: SqlParameter[]): this {
    this.wrapped.bind(...params);
    return this;
  }
}

/**
 * Create a performance-monitored database adapter
 */
export function createPerformanceMonitoredAdapter(adapter: DatabaseAdapter): DatabaseAdapter {
  return new DatabasePerformanceMonitor(adapter);
}

/**
 * Performance monitoring utilities for database optimization
 */
export class DatabaseOptimizationAnalyzer {
  /**
   * Analyze query performance and suggest optimizations
   */
  static analyzeQueryPerformance(sql: string, duration: number, rowCount?: number): {
    isSlow: boolean;
    suggestions: string[];
    issues: string[];
  } {
    const suggestions: string[] = [];
    const issues: string[] = [];
    const isSlow = duration > 1000; // Over 1 second is considered slow

    const normalized = sql.trim().toLowerCase();

    // Check for missing WHERE clause on large tables
    if (!normalized.includes('where') && normalized.startsWith('select')) {
      suggestions.push('Consider adding a WHERE clause to limit results');
      issues.push('SELECT without WHERE clause may scan entire table');
    }

    // Check for missing LIMIT
    if (!normalized.includes('limit') && normalized.startsWith('select')) {
      suggestions.push('Consider adding LIMIT to prevent large result sets');
    }

    // Check for SELECT *
    if (normalized.includes('select *')) {
      suggestions.push('Specify only required columns instead of SELECT *');
      issues.push('SELECT * retrieves unnecessary columns');
    }

    // Performance-based suggestions
    if (isSlow) {
      if (duration > 5000) {
        issues.push('Very slow query detected');
        suggestions.push('Consider query optimization or indexing');
      }

      if (rowCount === 0 && normalized.includes('where')) {
        suggestions.push('No rows found - check WHERE conditions');
      }

      if (rowCount && rowCount > 1000 && !normalized.includes('limit')) {
        suggestions.push('Large result set returned - consider pagination');
      }
    }

    // Index suggestions
    if (isSlow && normalized.includes('where') && !normalized.includes('indexed by')) {
      suggestions.push('Consider adding an index on WHERE clause columns');
    }

    return {
      isSlow,
      suggestions,
      issues,
    };
  }

  /**
   * Get database health metrics
   */
  static getDatabaseHealth(monitoring: any): {
    totalQueries: number;
    slowQueries: number;
    averageDuration: number;
    topSlowQueries: Array<{ query: string; duration: number; count: number }>;
    recommendations: string[];
  } {
    const recentMetrics = monitoring.getRecentMetrics(1000, { name: 'database_query_duration' });
    const dbQueries = recentMetrics.filter(m => m.name === 'database_query_duration');

    if (dbQueries.length === 0) {
      return {
        totalQueries: 0,
        slowQueries: 0,
        averageDuration: 0,
        topSlowQueries: [],
        recommendations: ['No database activity recorded'],
      };
    }

    const slowQueries = dbQueries.filter(m => m.value > 1000);
    const totalDuration = dbQueries.reduce((sum, m) => sum + m.value, 0);
    const averageDuration = totalDuration / dbQueries.length;

    // Group similar queries and find slowest types
    const queryGroups = new Map<string, { totalDuration: number; count: number; maxDuration: number }>();
    
    dbQueries.forEach(metric => {
      const queryType = metric.tags?.query_type || 'unknown';
      const table = metric.tags?.table || 'unknown';
      const key = `${queryType}_${table}`;
      
      if (!queryGroups.has(key)) {
        queryGroups.set(key, { totalDuration: 0, count: 0, maxDuration: 0 });
      }
      
      const group = queryGroups.get(key)!;
      group.totalDuration += metric.value;
      group.count += 1;
      group.maxDuration = Math.max(group.maxDuration, metric.value);
    });

    const topSlowQueries = Array.from(queryGroups.entries())
      .map(([key, data]) => ({
        query: key,
        duration: data.maxDuration,
        count: data.count,
      }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5);

    const recommendations: string[] = [];
    
    if (slowQueries.length > dbQueries.length * 0.1) {
      recommendations.push('High percentage of slow queries - investigate indexing');
    }
    
    if (averageDuration > 500) {
      recommendations.push('Average query duration is high - consider optimization');
    }
    
    if (topSlowQueries.length > 0 && topSlowQueries[0].duration > 5000) {
      recommendations.push(`Extremely slow queries detected (${topSlowQueries[0].query})`);
    }

    return {
      totalQueries: dbQueries.length,
      slowQueries: slowQueries.length,
      averageDuration,
      topSlowQueries,
      recommendations,
    };
  }
}
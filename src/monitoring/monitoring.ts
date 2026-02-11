/**
 * Production Monitoring Service
 * Integrates Sentry for error tracking, structured logging, and performance monitoring
 */

import * as Sentry from '@sentry/node';
import { logger, LogLevel } from '../utils/logger';

export interface MonitoringConfig {
  sentryDsn?: string;
  environment: string;
  serviceName: string;
  version: string;
  enableTracing: boolean;
  sampleRate: number;
  debug?: boolean;
}

export interface ErrorContext {
  userId?: string;
  sessionId?: string;
  operation?: string;
  nodeType?: string;
  workflowId?: string;
  requestId?: string;
  [key: string]: any;
}

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'milliseconds' | 'bytes' | 'count';
  tags?: Record<string, string>;
}

export interface DatabaseQueryMetric {
  query: string;
  duration: number;
  rowCount?: number;
  index?: string;
  tags?: Record<string, string>;
}

export interface OperationMetric {
  operation: string;
  duration: number;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

export interface ApmMetric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'timer';
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
  unit?: string;
}

export interface PerformanceAlert {
  metricName: string;
  threshold: number;
  operator: '>' | '<' | '>=' | '<=' | '==';
  currentValue: number;
  severity: 'warning' | 'critical';
  message: string;
  timestamp: number;
}

export class MonitoringService {
  private config: MonitoringConfig;
  private isInitialized = false;
  private metrics: ApmMetric[] = [];
  private alertThresholds: Map<string, { threshold: number; operator: string; severity: 'warning' | 'critical' }> = new Map();
  private performanceBuffer: Map<string, number[]> = new Map();

  constructor(config: MonitoringConfig) {
    this.config = {
      enableTracing: true,
      sampleRate: 0.1, // 10% sample rate for performance
      ...config,
    };
    
    this.initializeAlertThresholds();
  }

  /**
   * Initialize Sentry monitoring
   */
  async initialize(): Promise<void> {
    if (!this.config.sentryDsn) {
      logger.warn('Monitoring: No Sentry DSN provided, running in local mode');
      return;
    }

    try {
      Sentry.init({
        dsn: this.config.sentryDsn,
        environment: this.config.environment,
        release: `${this.config.serviceName}@${this.config.version}`,
        tracesSampleRate: this.config.enableTracing ? this.config.sampleRate : 0,
        debug: this.config.debug || false,
        integrations: [
          // Enable HTTP request tracking
          new Sentry.Integrations.Http({ tracing: true }),
          // Enable exception tracking
          new Sentry.Integrations.OnUncaughtException(),
          new Sentry.Integrations.OnUnhandledRejection(),
          // Enable performance monitoring
          ...(this.config.enableTracing ? [
            new Sentry.Integrations.Express({ 
              app: null // Will be bound to express app if available
            })
          ] : []),
        ],
        beforeSend: (event, hint) => {
          // Filter out noisy errors in development
          if (this.config.environment === 'development') {
            const errorMessage = hint.originalException?.toString() || '';
            
            // Filter out common development errors
            if (errorMessage.includes('ECONNREFUSED') && 
                errorMessage.includes('localhost')) {
              return null;
            }
            
            // Filter out validation errors that are expected during development
            if (errorMessage.includes('ValidationError') && 
                this.config.environment === 'development') {
              event.level = 'info'; // Downgrade validation errors to info in dev
            }
          }
          
          return event;
        },
      });

      this.isInitialized = true;
      logger.info('Monitoring: Sentry initialized successfully', {
        environment: this.config.environment,
        serviceName: this.config.serviceName,
        version: this.config.version,
        tracing: this.config.enableTracing,
      });

    } catch (error) {
      logger.error('Monitoring: Failed to initialize Sentry', { error });
      // Don't throw - monitoring failure shouldn't crash the app
    }
  }

  /**
   * Set user context for Sentry
   */
  setUser(context: { id?: string; email?: string; username?: string }): void {
    if (!this.isInitialized) return;

    Sentry.setUser(context);
    logger.debug('Monitoring: User context set', { userId: context.id });
  }

  /**
   * Set tags for context
   */
  setTags(tags: Record<string, string>): void {
    if (!this.isInitialized) return;

    Sentry.setTags(tags);
    logger.debug('Monitoring: Tags set', { tags });
  }

  /**
   * Set extra data for context
   */
  setExtras(extras: Record<string, any>): void {
    if (!this.isInitialized) return;

    Sentry.setExtras(extras);
    logger.debug('Monitoring: Extra data set', { keys: Object.keys(extras) });
  }

  /**
   * Capture exception with context
   */
  captureException(error: Error, context?: ErrorContext): void {
    const errorInfo = {
      message: error.message,
      stack: error.stack,
      name: error.name,
      context,
    };

    // Always log locally
    logger.error('Monitoring: Capturing exception', errorInfo);

    if (!this.isInitialized) return;

    // Add context to Sentry
    if (context) {
      Sentry.setExtras(context);
    }

    Sentry.captureException(error);
  }

  /**
   * Capture message with level
   */
  captureMessage(
    message: string, 
    level: Sentry.SeverityLevel = 'info',
    context?: ErrorContext
  ): void {
    const messageInfo = { message, level, context };

    // Log locally based on level
    switch (level) {
      case 'error':
        logger.error('Monitoring: Capturing message', messageInfo);
        break;
      case 'warning':
        logger.warn('Monitoring: Capturing message', messageInfo);
        break;
      default:
        logger.info('Monitoring: Capturing message', messageInfo);
    }

    if (!this.isInitialized) return;

    // Add context to Sentry
    if (context) {
      Sentry.setExtras(context);
    }

    Sentry.captureMessage(message, level);
  }

  /**
   * Start a performance transaction
   */
  startTransaction(name: string, operation: string = 'unknown'): Sentry.Transaction | null {
    if (!this.isInitialized || !this.config.enableTracing) {
      return null;
    }

    const transaction = Sentry.startTransaction({
      name,
      op: operation,
    });

    logger.debug('Monitoring: Transaction started', { name, operation });
    return transaction;
  }

  /**
   * Record a performance metric
   */
  recordMetric(metric: PerformanceMetric): void {
    logger.debug('Monitoring: Recording metric', metric);

    if (!this.isInitialized) return;

    // For now, log metrics to console. In a full implementation,
    // you might want to send these to a metrics service like DataDog
    const metricData = {
      ...metric,
      timestamp: new Date().toISOString(),
      serviceName: this.config.serviceName,
    };

    // Use Sentry custom measurements
    Sentry.addBreadcrumb({
      message: `Metric: ${metric.name}`,
      level: 'info',
      data: metricData,
    });
  }

  /**
   * Create a child span for an operation
   */
  startSpan(
    transaction: Sentry.Transaction | null,
    name: string, 
    operation: string = 'unknown'
  ): Sentry.Span | null {
    if (!transaction || !this.isInitialized) {
      return null;
    }

    const span = transaction.startChild({
      op: operation,
      description: name,
    });

    logger.debug('Monitoring: Span started', { name, operation, parent: transaction.name });
    return span;
  }

  /**
   * Finish a span with optional data
   */
  finishSpan(span: Sentry.Span | null, data?: Record<string, any>): void {
    if (!span) return;

    if (data) {
      span.setData('data', data);
    }

    span.finish();
    logger.debug('Monitoring: Span finished', { operation: span.op, description: span.description });
  }

  /**
   * Add breadcrumb for debugging
   */
  addBreadcrumb(
    message: string, 
    level: Sentry.SeverityLevel = 'info',
    category?: string,
    data?: Record<string, any>
  ): void {
    logger.debug('Monitoring: Adding breadcrumb', { message, level, category, data });

    if (!this.isInitialized) return;

    Sentry.addBreadcrumb({
      message,
      level,
      category,
      data,
    });
  }

  /**
   * Flush pending events
   */
  async flush(timeout: number = 2000): Promise<void> {
    if (!this.isInitialized) return;

    try {
      await Sentry.flush(timeout);
      logger.debug('Monitoring: Events flushed successfully');
    } catch (error) {
      logger.error('Monitoring: Failed to flush events', { error });
    }
  }

  /**
   * Initialize alert thresholds for performance monitoring
   */
  private initializeAlertThresholds(): void {
    // Database performance thresholds
    this.alertThresholds.set('database_query_duration', { threshold: 1000, operator: '>', severity: 'warning' });
    this.alertThresholds.set('database_query_duration_critical', { threshold: 5000, operator: '>', severity: 'critical' });
    
    // Node validation thresholds
    this.alertThresholds.set('node_validation_duration', { threshold: 500, operator: '>', severity: 'warning' });
    this.alertThresholds.set('node_validation_duration_critical', { threshold: 2000, operator: '>', severity: 'critical' });
    
    // Template fetching thresholds
    this.alertThresholds.set('template_fetch_duration', { threshold: 3000, operator: '>', severity: 'warning' });
    this.alertThresholds.set('template_fetch_duration_critical', { threshold: 10000, operator: '>', severity: 'critical' });
    
    // MCP tool execution thresholds
    this.alertThresholds.set('mcp_tool_duration', { threshold: 1000, operator: '>', severity: 'warning' });
    this.alertThresholds.set('mcp_tool_duration_critical', { threshold: 5000, operator: '>', severity: 'critical' });
    
    // Memory usage thresholds
    this.alertThresholds.set('memory_usage_mb', { threshold: 512, operator: '>', severity: 'warning' });
    this.alertThresholds.set('memory_usage_mb_critical', { threshold: 1024, operator: '>', severity: 'critical' });
  }

  /**
   * Record database query performance
   */
  recordDatabaseQuery(metric: DatabaseQueryMetric): void {
    const duration = metric.duration;
    const queryHash = this.hashQuery(metric.query);
    
    // Store query performance history
    if (!this.performanceBuffer.has(queryHash)) {
      this.performanceBuffer.set(queryHash, []);
    }
    const history = this.performanceBuffer.get(queryHash)!;
    history.push(duration);
    
    // Keep only last 100 queries per hash
    if (history.length > 100) {
      history.shift();
    }
    
    // Record base metric
    this.recordMetric({
      name: 'database_query_duration',
      value: duration,
      unit: 'milliseconds',
      tags: {
        query_hash: queryHash,
        row_count: metric.rowCount?.toString() || 'unknown',
        index: metric.index || 'none',
        ...metric.tags,
      },
    });
    
    // Check for performance alerts
    this.checkAlertThreshold('database_query_duration', duration, { query: metric.query });
    this.checkAlertThreshold('database_query_duration_critical', duration, { query: metric.query });
    
    // Log slow queries
    if (duration > 1000) {
      logger.warn('Slow database query detected', {
        query: metric.query,
        duration: `${duration}ms`,
        rowCount: metric.rowCount,
        index: metric.index,
      });
    }
  }

  /**
   * Record operation performance with metadata
   */
  recordOperation(metric: OperationMetric): void {
    const baseTags = {
      operation: metric.operation,
      success: metric.success.toString(),
      ...((metric.errorCode && { error_code: metric.errorCode }) || {}),
    };
    
    // Record duration
    this.recordMetric({
      name: `${metric.operation}_duration`,
      value: metric.duration,
      unit: 'milliseconds',
      tags: baseTags,
    });
    
    // Record success/failure counter
    this.recordMetric({
      name: `${metric.operation}_calls`,
      value: 1,
      unit: 'count',
      tags: baseTags,
    });
    
    // Add to performance buffer for trend analysis
    const bufferKey = `${metric.operation}_duration`;
    if (!this.performanceBuffer.has(bufferKey)) {
      this.performanceBuffer.set(bufferKey, []);
    }
    const history = this.performanceBuffer.get(bufferKey)!;
    history.push(metric.duration);
    
    // Keep only last 100 operations
    if (history.length > 100) {
      history.shift();
    }
    
    // Check alerts for this operation type
    this.checkAlertThreshold(`${metric.operation}_duration`, metric.duration, {
      operation: metric.operation,
      success: metric.success,
    });
    
    // Log failed operations
    if (!metric.success) {
      logger.error('Operation failed', {
        operation: metric.operation,
        duration: metric.duration,
        errorCode: metric.errorCode,
        errorMessage: metric.errorMessage,
      });
    }
  }

  /**
   * Record custom APM metric
   */
  recordApmMetric(metric: ApmMetric): void {
    this.metrics.push(metric);
    
    // Keep only last 10000 metrics in memory
    if (this.metrics.length > 10000) {
      this.metrics.shift();
    }
    
    // Add breadcrumb to Sentry
    if (this.isInitialized) {
      Sentry.addBreadcrumb({
        message: `APM Metric: ${metric.name}`,
        level: 'info',
        data: {
          type: metric.type,
          value: metric.value,
          unit: metric.unit,
          tags: metric.tags,
        },
      });
    }
    
    logger.debug('APM metric recorded', metric);
  }

  /**
   * Check and trigger alerts based on thresholds
   */
  private checkAlertThreshold(thresholdKey: string, value: number, context: Record<string, any> = {}): void {
    const threshold = this.alertThresholds.get(thresholdKey);
    if (!threshold) return;
    
    let triggered = false;
    switch (threshold.operator) {
      case '>':
        triggered = value > threshold.threshold;
        break;
      case '<':
        triggered = value < threshold.threshold;
        break;
      case '>=':
        triggered = value >= threshold.threshold;
        break;
      case '<=':
        triggered = value <= threshold.threshold;
        break;
      case '==':
        triggered = value === threshold.threshold;
        break;
    }
    
    if (triggered) {
      const alert: PerformanceAlert = {
        metricName: thresholdKey,
        threshold: threshold.threshold,
        operator: threshold.operator as any,
        currentValue: value,
        severity: threshold.severity,
        message: `Performance alert: ${thresholdKey} is ${value} (threshold: ${threshold.operator} ${threshold.threshold})`,
        timestamp: Date.now(),
      };
      
      this.triggerAlert(alert, context);
    }
  }

  /**
   * Trigger performance alert
   */
  private triggerAlert(alert: PerformanceAlert, context: Record<string, any>): void {
    const alertData = {
      ...alert,
      context,
      serviceName: this.config.serviceName,
      environment: this.config.environment,
    };
    
    // Log the alert
    if (alert.severity === 'critical') {
      logger.error('Critical performance alert', alertData);
    } else {
      logger.warn('Performance warning', alertData);
    }
    
    // Send to Sentry
    if (this.isInitialized) {
      if (alert.severity === 'critical') {
        Sentry.captureException(new Error(alert.message), {
          tags: { type: 'performance_alert', severity: alert.severity },
          extra: alertData,
        });
      } else {
        Sentry.captureMessage(alert.message, 'warning', {
          tags: { type: 'performance_alert', severity: alert.severity },
          extra: alertData,
        });
      }
    }
  }

  /**
   * Get performance statistics for analysis
   */
  getPerformanceStats(metricName: string): {
    count: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const values = this.performanceBuffer.get(metricName);
    if (!values || values.length === 0) {
      return null;
    }
    
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    
    return {
      count,
      avg: sum / count,
      min: sorted[0],
      max: sorted[count - 1],
      p50: sorted[Math.floor(count * 0.5)],
      p95: sorted[Math.floor(count * 0.95)],
      p99: sorted[Math.floor(count * 0.99)],
    };
  }

  /**
   * Get recent APM metrics
   */
  getRecentMetrics(limit: number = 100, filter?: { type?: string; name?: string }): ApmMetric[] {
    let filtered = [...this.metrics];
    
    if (filter) {
      if (filter.type) {
        filtered = filtered.filter(m => m.type === filter.type);
      }
      if (filter.name) {
        filtered = filtered.filter(m => m.name.includes(filter.name));
      }
    }
    
    return filtered.slice(-limit);
  }

  /**
   * Record memory usage
   */
  recordMemoryUsage(): void {
    const memUsage = process.memoryUsage();
    const memUsageMb = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    this.recordApmMetric({
      name: 'memory_usage_mb',
      type: 'gauge',
      value: memUsageMb,
      unit: 'MB',
      timestamp: Date.now(),
      tags: {
        heap_total: Math.round(memUsage.heapTotal / 1024 / 1024).toString(),
        external: Math.round(memUsage.external / 1024 / 1024).toString(),
        rss: Math.round(memUsage.rss / 1024 / 1024).toString(),
      },
    });
    
    // Check memory alerts
    this.checkAlertThreshold('memory_usage_mb', memUsageMb);
    this.checkAlertThreshold('memory_usage_mb_critical', memUsageMb);
  }

  /**
   * Simple hash function for query normalization
   */
  private hashQuery(query: string): string {
    // Remove specific values and normalize whitespace for grouping similar queries
    const normalized = query
      .replace(/\b\d+\b/g, '?') // Replace numbers with ?
      .replace(/\b'[a-zA-Z0-9_-]+'\b/g, '?') // Replace quoted strings with ?
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    // Simple hash
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Get health status with performance metrics
   */
  getHealthStatus(): { 
    isInitialized: boolean; 
    config: Partial<MonitoringConfig>;
    performance?: {
      metricsCount: number;
      bufferedOperations: number;
      recentAlerts: number;
      memoryUsageMb: number;
    };
  } {
    const memUsage = process.memoryUsage();
    const memUsageMb = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    return {
      isInitialized: this.isInitialized,
      config: {
        environment: this.config.environment,
        serviceName: this.config.serviceName,
        version: this.config.version,
        enableTracing: this.config.enableTracing,
        sampleRate: this.config.sampleRate,
        hasDsn: !!this.config.sentryDsn,
      },
      performance: {
        metricsCount: this.metrics.length,
        bufferedOperations: Array.from(this.performanceBuffer.values()).reduce((sum, arr) => sum + arr.length, 0),
        recentAlerts: 0, // Could track this if needed
        memoryUsageMb: memUsageMb,
      },
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    await this.flush(5000);
    logger.info('Monitoring: Service shutdown complete');
  }
}

// Create default monitoring instance
export const monitoring = new MonitoringService({
  environment: process.env.NODE_ENV || 'development',
  serviceName: 'n8n-mcp',
  version: process.env.npm_package_version || 'unknown',
  sentryDsn: process.env.SENTRY_DSN,
  enableTracing: process.env.NODE_ENV === 'production',
  sampleRate: parseFloat(process.env.SENTRY_SAMPLE_RATE || '0.1'),
  debug: process.env.SENTRY_DEBUG === 'true',
});

// Helper function for monitoring async operations
export async function withMonitoring<T>(
  operationName: string,
  operation: () => Promise<T>,
  context?: ErrorContext
): Promise<T> {
  const transaction = monitoring.startTransaction(operationName, 'function');
  const span = monitoring.startSpan(transaction, operationName, 'function');

  try {
    // Set context for the operation
    if (context) {
      monitoring.setTags({
        operation: operationName,
        ...Object.fromEntries(
          Object.entries(context).map(([k, v]) => [k, String(v)])
        ),
      });
    }

    monitoring.addBreadcrumb(`Starting ${operationName}`, 'info', 'operation');
    
    const startTime = Date.now();
    const result = await operation();
    const duration = Date.now() - startTime;

    // Record performance metric
    monitoring.recordMetric({
      name: `${operationName}_duration`,
      value: duration,
      unit: 'milliseconds',
      tags: { success: 'true' },
    });

    monitoring.addBreadcrumb(`Completed ${operationName}`, 'info', 'operation', {
      duration: `${duration}ms`,
    });

    return result;

  } catch (error) {
    monitoring.addBreadcrumb(`Failed ${operationName}`, 'error', 'operation', {
      error: error instanceof Error ? error.message : String(error),
    });

    monitoring.captureException(error as Error, {
      ...context,
      operation: operationName,
    });

    throw error;

  } finally {
    monitoring.finishSpan(span);
    if (transaction) {
      transaction.finish();
    }
  }
}
/**
 * Monitoring initialization and configuration
 * Integrates monitoring with the MCP server lifecycle
 */

import { monitoring, MonitoringService } from './monitoring';
import { logger } from '../utils/logger';

export interface MonitoringBootstrapConfig {
  serviceName?: string;
  version?: string;
  sentryDsn?: string;
  environment?: string;
}

/**
 * Bootstrap monitoring service with proper configuration
 */
export async function bootstrapMonitoring(
  config?: MonitoringBootstrapConfig
): Promise<MonitoringService> {
  const monitoringConfig = {
    environment: process.env.NODE_ENV || 'development',
    serviceName: config?.serviceName || process.env.SERVICE_NAME || 'n8n-mcp',
    version: config?.version || process.env.npm_package_version || '2.33.5',
    sentryDsn: config?.sentryDsn || process.env.SENTRY_DSN,
    enableTracing: process.env.NODE_ENV === 'production',
    sampleRate: parseFloat(process.env.SENTRY_SAMPLE_RATE || '0.1'),
    debug: process.env.SENTRY_DEBUG === 'true',
  };

  // Create monitoring instance with configuration
  const monitoringService = new MonitoringService(monitoringConfig);

  try {
    await monitoringService.initialize();

    // Set up global error handlers
    setupGlobalErrorHandlers(monitoringService);

    // Log successful initialization
    logger.info('Monitoring bootstrapped successfully', {
      environment: monitoringConfig.environment,
      serviceName: monitoringConfig.serviceName,
      version: monitoringConfig.version,
      hasDsn: !!monitoringConfig.sentryDsn,
      tracing: monitoringConfig.enableTracing,
    });

    return monitoringService;

  } catch (error) {
    logger.error('Failed to bootstrap monitoring', { error });
    // Return the service anyway - it will work in local mode
    return monitoringService;
  }
}

/**
 * Set up global error handlers for uncaught exceptions and unhandled rejections
 */
function setupGlobalErrorHandlers(monitoringService: MonitoringService): void {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    
    monitoringService.captureException(error, {
      type: 'uncaughtException',
      processId: process.pid,
      uptime: process.uptime(),
    });

    // Give monitoring time to capture the error before exiting
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: any, promise: Promise<unknown>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    
    logger.error('Unhandled Promise Rejection', {
      reason: error.message,
      stack: error.stack,
    });

    monitoringService.captureException(error, {
      type: 'unhandledRejection',
      reason: String(reason),
      processId: process.pid,
      uptime: process.uptime(),
    });

    // Don't exit for unhandled rejections in newer Node.js versions,
    // but log them properly
  });

  // Handle warning events
  process.on('warning', (warning: Error) => {
    logger.warn('Process Warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });

    monitoringService.captureMessage(
      `Process Warning: ${warning.name}`,
      'warning',
      {
        type: 'processWarning',
        name: warning.name,
        message: warning.message,
      }
    );
  });

  // Handle SIGTERM for graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, starting graceful shutdown');
    
    monitoringService.addBreadcrumb('SIGTERM received, starting shutdown', 'info', 'lifecycle');
    
    monitoringService.shutdown().then(() => {
      process.exit(0);
    }).catch((error) => {
      logger.error('Error during monitoring shutdown', { error });
      process.exit(1);
    });
  });

  // Handle SIGINT for graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, starting graceful shutdown');
    
    monitoringService.addBreadcrumb('SIGINT received, starting shutdown', 'info', 'lifecycle');
    
    monitoringService.shutdown().then(() => {
      process.exit(0);
    }).catch((error) => {
      logger.error('Error during monitoring shutdown', { error });
      process.exit(1);
    });
  });
}

/**
 * Initialize monitoring for MCP operations
 */
export function initializeMcpMonitoring(
  sessionId?: string,
  userId?: string
): void {
  if (sessionId) {
    monitoring.setTags({ sessionId });
  }
  
  if (userId) {
    monitoring.setUser({ id: userId });
  }

  monitoring.setTags({
    service: 'n8n-mcp',
    protocol: 'mcp',
    nodeEnv: process.env.NODE_ENV || 'development',
  });

  monitoring.setExtras({
    processId: process.pid,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    platform: process.platform,
    nodeVersion: process.version,
  });

  logger.debug('MCP monitoring context initialized', { sessionId, userId });
}

/**
 * Monitoring helpers for MCP operations
 */
export const McpMonitoring = {
  /**
   * Track node validation operation
   */
  trackNodeValidation: (
    nodeType: string, 
    operation: string, 
    duration: number, 
    success: boolean
  ): void => {
    monitoring.recordMetric({
      name: 'node_validation_duration',
      value: duration,
      unit: 'milliseconds',
      tags: {
        nodeType,
        operation,
        success: success.toString(),
      },
    });

    monitoring.addBreadcrumb(
      `Node validation ${success ? 'completed' : 'failed'}`,
      success ? 'info' : 'warning',
      'validation',
      { nodeType, operation, duration: `${duration}ms` }
    );
  },

  /**
   * Track workflow operation
   */
  trackWorkflowOperation: (
    operation: string,
    workflowId?: string,
    nodeCount?: number,
    duration?: number,
    success: boolean = true
  ): void => {
    const tags: Record<string, string> = {
      operation,
      success: success.toString(),
    };

    if (workflowId) tags.workflowId = workflowId;
    if (nodeCount) tags.nodeCount = nodeCount.toString();

    monitoring.recordMetric({
      name: 'workflow_operation_duration',
      value: duration || 0,
      unit: 'milliseconds',
      tags,
    });

    monitoring.addBreadcrumb(
      `Workflow operation ${success ? 'completed' : 'failed'}`,
      success ? 'info' : 'warning',
      'workflow',
      { operation, workflowId, nodeCount, duration: `${duration || 0}ms` }
    );
  },

  /**
   * Track API calls to n8n
   */
  trackN8nApiCall: (
    endpoint: string,
    method: string,
    statusCode: number,
    duration: number
  ): void => {
    monitoring.recordMetric({
      name: 'n8n_api_duration',
      value: duration,
      unit: 'milliseconds',
      tags: {
        endpoint,
        method,
        statusCode: statusCode.toString(),
        success: (statusCode < 400).toString(),
      },
    });

    monitoring.addBreadcrumb(
      `n8n API ${method} ${endpoint}`,
      statusCode < 400 ? 'info' : 'warning',
      'api',
      { endpoint, method, statusCode, duration: `${duration}ms` }
    );
  },

  /**
   * Track database operations
   */
  trackDatabaseOperation: (
    operation: string,
    table: string,
    duration: number,
    success: boolean = true
  ): void => {
    monitoring.recordMetric({
      name: 'database_operation_duration',
      value: duration,
      unit: 'milliseconds',
      tags: {
        operation,
        table,
        success: success.toString(),
      },
    });

    monitoring.addBreadcrumb(
      `Database ${operation} on ${table}`,
      success ? 'info' : 'warning',
      'database',
      { operation, table, duration: `${duration}ms` }
    );
  },
};

/**
 * Environment-specific monitoring configurations
 */
export const MonitoringConfigs = {
  /**
   * Development configuration
   */
  development: {
    environment: 'development',
    enableTracing: false,
    sampleRate: 0.0, // No tracing in dev
    debug: true,
  },

  /**
   * Staging configuration
   */
  staging: {
    environment: 'staging',
    enableTracing: true,
    sampleRate: 0.5, // Higher sample rate for staging
    debug: false,
  },

  /**
   * Production configuration
   */
  production: {
    environment: 'production',
    enableTracing: true,
    sampleRate: 0.1, // Standard production sample rate
    debug: false,
  },
};
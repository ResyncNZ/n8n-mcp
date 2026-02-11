/**
 * Sentry monitoring setup for production error tracking
 * Conceived by Romuald Członkowski - www.aiadvisors.pl/en
 */

import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger';

/**
 * Initialize Sentry for error tracking
 * Only initializes if SENTRY_DSN environment variable is set
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  
  if (!dsn) {
    logger.info('[Sentry] Monitoring disabled - SENTRY_DSN not set');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.npm_package_version || 'unknown',
    
    // Performance monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    
    // Error sampling
    sampleRate: 1.0,
    
    // Enable debug mode in non-production
    debug: process.env.NODE_ENV !== 'production',
    
    // Before send hook for filtering
    beforeSend(event) {
      // Filter out specific errors if needed
      if (event.exception?.values?.[0]?.type === 'DatabaseConnectionError') {
        // Add extra context for database errors
        event.tags = { ...event.tags, category: 'database' };
      }
      return event;
    },
  });

  logger.info('[Sentry] Initialized successfully');
}

/**
 * Capture an exception with Sentry
 */
export function captureException(error: Error, context?: Record<string, any>): void {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error, {
      extra: context,
    });
  }
}

/**
 * Capture a message with Sentry
 */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(message, level);
  }
}

/**
 * Set user context for Sentry
 */
export function setUserContext(user: { id?: string; email?: string; username?: string }): void {
  if (process.env.SENTRY_DSN) {
    Sentry.setUser(user);
  }
}

/**
 * Add breadcrumb for tracking user actions
 */
export function addBreadcrumb(message: string, category?: string, data?: Record<string, any>): void {
  if (process.env.SENTRY_DSN) {
    Sentry.addBreadcrumb({
      message,
      category,
      data,
      level: 'info',
    });
  }
}

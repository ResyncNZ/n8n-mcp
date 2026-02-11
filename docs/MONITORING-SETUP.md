# Production Monitoring Setup

This guide explains how to configure and set up production monitoring for the n8n-mcp service using Sentry.

## Overview

The n8n-mcp service includes comprehensive monitoring with:
- **Error Tracking**: Captures exceptions and unhandled rejections
- **Performance Monitoring**: Tracks operation durations and bottlenecks  
- **Structured Logging**: Centralized logging with context
- **Health Checks**: Monitoring service status and configuration

## Environment Variables

Configure these environment variables for monitoring:

### Required Variables

```bash
# Sentry configuration
SENTRY_DSN=https://your-sentry-dsn@sentry.io/project-id
NODE_ENV=production

# Service identification  
SERVICE_NAME=n8n-mcp
```

### Optional Variables

```bash
# Performance monitoring
SENTRY_SAMPLE_RATE=0.1          # Sample 10% of transactions (default: 0.1)
SENTRY_TRACES_SAMPLE_RATE=0.1   # Alternative sample rate setting

# Debug mode
SENTRY_DEBUG=true               # Enable debug logging (default: false)

# Application context
npm_package_version=2.33.5       # Application version (auto-detected)
```

## Sentry Setup

### 1. Create Sentry Project

1. Go to [Sentry.io](https://sentry.io)
2. Create a new project for "Node.js"
3. Select "Express" or "Node.js" as platform
4. Copy the DSN to your environment variables

### 2. Configure Error Tracking

The service automatically captures:
- Uncaught exceptions
- Unhandled promise rejections
- Application errors with full context
- Performance metrics

### 3. Set Up Alerts

Configure these alerts in Sentry:

#### Critical Alerts
- **Error rate increase** > 50% over 1 hour
- **New error introduction** (any new error type)
- **Failed API calls** > 10% error rate

#### Warning Alerts  
- **Response time degradation** > 2 seconds P95
- **Memory usage** > 80% of limit
- **Database timeout errors** > 5 per hour

## Monitoring Configuration by Environment

### Development
```bash
NODE_ENV=development
SENTRY_DEBUG=true
SENTRY_SAMPLE_RATE=0.0  # Disable tracing
```
- Full debug logging enabled
- No performance tracing (reduces noise)
- All errors captured for debugging

### Staging
```bash
NODE_ENV=staging
SENTRY_SAMPLE_RATE=0.5  # Higher sampling for testing
SENTRY_DEBUG=false
```
- Production-like error tracking
- Higher sample rate for performance testing
- Debug mode disabled

### Production
```bash
NODE_ENV=production
SENTRY_SAMPLE_RATE=0.1  # Standard sampling
SENTRY_DEBUG=false
```
- Optimized for production
- 10% performance sampling
- Minimal debug output

## Docker Configuration

Add these environment variables to your Docker compose:

```yaml
services:
  n8n-mcp:
    image: n8n-mcp:latest
    environment:
      - SENTRY_DSN=${SENTRY_DSN}
      - NODE_ENV=production
      - SERVICE_NAME=n8n-mcp
      - SENTRY_SAMPLE_RATE=0.1
    # ... other configuration
```

## Kubernetes Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: n8n-mcp
spec:
  template:
    spec:
      containers:
      - name: n8n-mcp
        env:
        - name: SENTRY_DSN
          valueFrom:
            secretKeyRef:
              name: monitoring-secrets
              key: sentry-dsn
        - name: NODE_ENV
          value: "production"
        - name: SERVICE_NAME
          value: "n8n-mcp"
        - name: SENTRY_SAMPLE_RATE
          value: "0.1"
```

## Monitoring Dashboard Setup

### Key Metrics to Track

1. **Error Rate**
   - Total errors over time
   - Error rate by operation type
   - Top error messages

2. **Performance**
   - Response time percentiles (P50, P95, P99)
   - Slowest operations
   - Database query performance

3. **System Health**
   - Memory usage trends
   - CPU utilization
   - Request rate patterns

4. **Business Metrics**
   - Workflow validation success rate
   - API call success rate
   - Active session counts

### Recommended Dashboards

#### 1. Service Health Dashboard
- Overall error rate
- Response time trends  
- Request throughput
- System resource usage

#### 2. Operations Dashboard
- Node validation performance
- Workflow operation success rate
- Database operation times
- External API call metrics

#### 3. User Impact Dashboard
- Error rate by user/session
- Failed operations by type
- Performance by workflow complexity
- Session health indicators

## Alerting Best Practices

### Alert Severity Levels

**Critical (Immediate Response Required)**
- Service downtime (5xx errors > 10%)
- Database connection failures
- Security-related errors
- Complete service unavailability

**High (Response within 1 hour)**
- Error rate increase > 50%
- Performance degradation > 2x baseline
- Authentication failures
- Data integrity issues

**Medium (Response within 4 hours)**
- Individual feature failures
- Performance degradation < 2x
- Configuration issues
- Resource utilization warnings

**Low (Next business day)**
- Debug information
- Performance optimizations
- Documentation issues
- Minor configuration problems

### Notification Channels

Configure multi-channel alerts:
- **Slack**: Real-time alerts for critical issues
- **Email**: Detailed reports and summaries
- **PagerDuty**: Critical after-hours alerts
- **Teams**: Collaboration and discussion

## Testing the Monitoring Setup

### 1. Verify Initialization
```bash
# Check if monitoring is initialized correctly
curl http://localhost:3000/health
```

### 2. Test Error Capture
```javascript
// Trigger a test error in your code
throw new Error('Test error for monitoring verification');
```

### 3. Test Performance Tracking
```javascript
// Verify performance metrics are captured
await someSlowOperation(); // Should create performance spans
```

### 4. Test Alerting
- Trigger a controlled error
- Verify alerts are received
- Check dashboard updates

## Troubleshooting

### Common Issues

**Monitoring not initializing**
```bash
# Check environment variables
echo $SENTRY_DSN
echo $NODE_ENV

# Verify Sentry DSN format
# Should be: https://[public-key]@[sentry-host]/[project-id]
```

**No errors appearing in Sentry**
1. Check SENTRY_DSN is correct
2. Verify network connectivity to Sentry
3. Check Sentry project configuration
4. Review error filters

**Performance data missing**
1. Verify `SENTRY_SAMPLE_RATE > 0`
2. Check if tracing is enabled
3. Review transaction configuration
4. Verify sampling settings

### Debug Mode
Enable debug logging to troubleshoot:
```bash
SENTRY_DEBUG=true
NODE_ENV=development
```

### Health Check Endpoint
Monitor service health:
```bash
curl http://localhost:3000/health | jq
```

Response format:
```json
{
  "status": "healthy",
  "monitoring": {
    "isInitialized": true,
    "environment": "production",
    "serviceName": "n8n-mcp"
  }
}
```

## Security Considerations

1. **Environment Variables**: Store SENTRY_DSN securely
2. **Data Sanitization**: Review sensitive data filtering
3. **Access Control**: Limit Sentry dashboard access
4. **Data Retention**: Configure appropriate retention policies
5. **PII Filtering**: Ensure personal data is not sent to Sentry

## Migration from Legacy Logging

### Before (console.log)
```javascript
console.error('Error occurred:', error);
```

### After (structured monitoring)
```javascript
import { monitoring } from './monitoring';

monitoring.captureException(error, {
  operation: 'workflow-validation',
  nodeType: 'n8n-nodes-base.httpRequest',
  userId: 'user-123'
});
```

This ensures consistent error tracking, better context, and integration with your monitoring infrastructure.
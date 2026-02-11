# Monitoring Alerting Guide

This guide explains how to set up comprehensive alerting for the n8n-mcp service using Sentry.

## Alert Configuration

### Critical Alerts (Immediate Response Required)

#### 1. Service Downtime
```yaml
# Sentry Rule: Service Unavailability
name: "Service Downtime"
query: "event.type:error AND message:\"Cannot start server\""
environment: production
frequency: 1m
threshold: 1
actions:
  - slack: "#alerts-critical"
  - pagerduty: "n8n-mcp-critical"
```

#### 2. Database Connection Failures
```yaml
# Sentry Rule: Database Issues
name: "Database Connection Failed"
query: "event.type:error AND message:\"database\" OR message:\"nodes.db\""
environment: production
frequency: 5m
threshold: 3
actions:
  - slack: "#alerts-critical"
  - email: "devops@company.com"
```

#### 3. Authentication Failures
```yaml
# Sentry Rule: Authentication Issues
name: "High Authentication Failure Rate"
query: "event.type:error AND message:\"authentication\" OR message:\"unauthorized\""
environment: production
frequency: 5m
threshold: 10
actions:
  - slack: "#alerts-security"
```

### High Priority Alerts (Response within 1 hour)

#### 4. Tool Execution Failures
```yaml
# Sentry Rule: Tool Failures
name: "High Tool Error Rate"
query: "event.type:error AND tags.tool_execution:true"
environment: production
frequency: 10m
threshold: 5%
actions:
  - slack: "#alerts-engineering"
  - email: "backend-team@company.com"
```

#### 5. Performance Degradation
```yaml
# Sentry Rule: Performance Issues
name: "Response Time Degradation"
query: "transaction.duration:>2000ms"
environment: production
frequency: 15m
threshold: 10
actions:
  - slack: "#alerts-performance"
```

#### 6. Memory Issues
```yaml
# Sentry Rule: Memory Leaks
name: "High Memory Usage"
query: "event.type:error AND message:\"memory\" OR message:\"out of memory\""
environment: production
frequency: 10m
threshold: 1
actions:
  - slack: "#alerts-infrastructure"
  - email: "devops@company.com"
```

### Medium Priority Alerts (Response within 4 hours)

#### 7. n8n API Issues
```yaml
# Sentry Rule: External API Issues
name: "n8n API Connectivity Issues"
query: "event.type:error AND message:\"n8n\" AND message:\"api\""
environment: production
frequency: 30m
threshold: 5
actions:
  - slack: "#alerts-integrations"
```

#### 8. Validation Errors
```yaml
# Sentry Rule: Validation Failures
name: "High Validation Error Rate"
query: "event.type:error AND tags.tool_name:\"validate_\""
environment: production
frequency: 1h
threshold: 20
actions:
  - slack: "#alerts-quality"
```

### Low Priority Alerts (Next business day)

#### 9. Configuration Issues
```yaml
# Sentry Rule: Configuration Problems
name: "Configuration Issues"
query: "event.type:error AND message:\"configuration\" OR message:\"missing\""
environment: production
frequency: 4h
threshold: 1
actions:
  - slack: "#alerts-ops"
  - email: "devops@company.com"
```

#### 10. Debug Mode in Production
```yaml
# Sentry Rule: Debug Mode
name: "Debug Mode in Production"
query: "event.type:info AND message:\"debug\""
environment: production
frequency: 1h
threshold: 1
actions:
  - slack: "#alerts-ops"
```

## Dashboard Configuration

### Service Health Dashboard
Create these panels in your monitoring dashboard:

#### Overview Panel
- **Error Rate**: `(errors / total_requests) * 100`
- **Request Rate**: `count(transactions)` per minute
- **Average Response Time**: `avg(transaction.duration)`
- **Uptime**: `1 - (downtime_minutes / total_minutes)`

#### Performance Panel
- **P50 Response Time**: `percentile(transaction.duration, 0.5)`
- **P95 Response Time**: `percentile(transaction.duration, 0.95)`
- **P99 Response Time**: `percentile(transaction.duration, 0.99)`
- **Throughput**: `count(transactions)` per second

#### Error Analysis Panel
- **Errors by Tool**: `group_by(tags.tool_name)`
- **Errors by Session**: `group_by(tags.session_id)`
- **Error Rate Trend**: `time_series((errors / requests) * 100)`
- **Top Error Messages**: `top_k(message, 10)`

#### Infrastructure Panel
- **Memory Usage**: `avg(memory.heap_used)`
- **CPU Usage**: `avg(cpu.percent)`
- **Active Sessions**: `count(active_sessions)`
- **Database Connections**: `count(database_connections)`

## Notification Channels Setup

### Slack Integration
```bash
# Create Slack app and install to workspace
# Add incoming webhook URLs to environment variables
export SLACK_WEBHOOK_CRITICAL="https://hooks.slack.com/services/..."
export SLACK_WEBHOOK_ENGINEERING="https://hooks.slack.com/services/..."
export SLACK_WEBHOOK_OPERATIONS="https://hooks.slack.com/services/..."
```

### PagerDuty Integration
```bash
# Create PagerDuty service and integration key
export PAGERDUTY_INTEGRATION_KEY="your-integration-key"
```

### Email Configuration
```yaml
# SMTP settings for email alerts
smtp:
  host: smtp.company.com
  port: 587
  username: alerts@company.com
  password: ${SMTP_PASSWORD}
  from: "n8n-mcp Alerts <alerts@company.com>"
```

## Runbooks

### Critical: Service Downtime
**Symptoms**: Service unreachable, 5xx errors, database connection failures

**Immediate Actions**:
1. Check service status: `curl http://localhost:3000/health`
2. Check system resources: `top`, `free -h`, `df -h`
3. Check logs: `journalctl -u n8n-mcp --since "1 hour ago"`
4. Restart service if needed: `systemctl restart n8n-mcp`

**Escalation**: If service doesn't recover within 5 minutes, escalate to on-call engineer.

### High: Performance Degradation
**Symptoms**: Response times >2 seconds, high memory usage, slow operations

**Investigation Steps**:
1. Check Sentry performance transactions
2. Identify slow operations: `transaction.duration:>2000ms`
3. Check system resources and database connections
4. Review recent code deployments

**Solutions**:
- Scale horizontally if resource constrained
- Optimize slow database queries
- Add caching layers
- Review configuration changes

### Medium: API Integration Issues
**Symptoms**: n8n API failures, authentication errors, webhook issues

**Troubleshooting**:
1. Verify n8n API connectivity: `curl -H "Authorization: Bearer $KEY" $N8N_API_URL/api/v1/workflows`
2. Check API credentials and permissions
3. Review n8n instance status
4. Test webhook endpoints

**Resolution**:
- Update API credentials if expired
- Configure firewall rules if needed
- Update n8n instance configuration

## Maintenance Windows

### Scheduled Maintenance
- **Frequency**: Monthly patches, quarterly updates
- **Duration**: 2-hour maintenance window
- **Notification**: 24 hours advance notice
- **Coverage**: Blue-green deployment for zero downtime

### Health Checks During Maintenance
```bash
# Before maintenance
curl http://localhost:3000/health | jq '.status'

# After maintenance
curl http://localhost:3000/health | jq '.monitoring.isInitialized'
```

### Rollback Procedures
```bash
# Rollback to previous version
docker tag n8n-mcp:previous n8n-mcp:current
docker service update n8n-mcp

# Verify rollback
curl http://localhost:3000/health
```

## Monitoring as Code

### Terraform Configuration
```terraform
resource "sentry_issue_alert" "service_downtime" {
  organization = "your-org"
  project     = "n8n-mcp"
  
  name       = "Service Downtime"
  query      = "event.type:error AND message:\"Cannot start server\""
  environment = ["production"]
  frequency  = 60
  threshold  = 1
  
  actions {
    action_type = "slack"
    target      = "https://hooks.slack.com/services/..."
  }
  
  actions {
    action_type = "pagerduty"
    target      = var.pagerduty_integration_key
  }
}
```

### Infrastructure Monitoring
```yaml
# Prometheus configuration for n8n-mcp
scrape_configs:
  - job_name: 'n8n-mcp'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
    scrape_interval: 30s

# Alert rules
groups:
  - name: n8n-mcp
    rules:
      - alert: ServiceDown
        expr: up{job="n8n-mcp"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "n8n-mcp service is down"
          
      - alert: HighMemoryUsage
        expr: memory_usage_bytes{job="n8n-mcp"} / 1024 / 1024 > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage on n8n-mcp"
```

This comprehensive alerting setup ensures you're immediately notified of critical issues while keeping noise to a minimum through proper severity classification and threshold tuning.
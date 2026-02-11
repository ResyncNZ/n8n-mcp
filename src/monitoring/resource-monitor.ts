/**
 * Memory and CPU Performance Monitor
 * Tracks memory usage patterns, detects leaks, and monitors CPU utilization
 */

import { monitoring } from '../monitoring/monitoring';
import { logger } from '../utils/logger';

interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
}

interface CpuSnapshot {
  timestamp: number;
  user: number;
  system: number;
}

interface MemoryTrend {
  trend: 'increasing' | 'decreasing' | 'stable';
  rate: number; // MB per minute
  severity: 'low' | 'medium' | 'high' | 'critical';
  timeToThreshold: number; // Minutes until 1GB threshold
}

interface MemoryLeakDetection {
  isLeaking: boolean;
  confidence: number; // 0-100
  rate: number; // MB per hour
  patterns: Array<{
    operation: string;
    growthRate: number;
    samples: number;
  }>;
}

export class ResourceMonitor {
  private memorySnapshots: MemorySnapshot[] = [];
  private cpuSnapshots: CpuSnapshot[] = [];
  private lastCpuUsage: NodeJS.CpuUsage;
  private startTime = Date.now();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private readonly maxSnapshots = 1000;
  private readonly memoryThresholdMB = 1024; // 1GB
  private readonly samplingIntervalMs = 30000; // 30 seconds

  constructor() {
    this.lastCpuUsage = process.cpuUsage();
    this.startPeriodicMonitoring();
  }

  /**
   * Start periodic resource monitoring
   */
  private startPeriodicMonitoring(): void {
    this.monitoringInterval = setInterval(() => {
      this.captureMemorySnapshot();
      this.captureCpuSnapshot();
      this.analyzeMemoryTrends();
      this.detectMemoryLeaks();
    }, this.samplingIntervalMs);

    // Initial capture
    this.captureMemorySnapshot();
    this.captureCpuSnapshot();
  }

  /**
   * Capture current memory usage snapshot
   */
  private captureMemorySnapshot(): void {
    const memUsage = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024), // MB
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      arrayBuffers: Math.round((memUsage as any).arrayBuffers / 1024 / 1024) || 0, // MB
    };

    this.memorySnapshots.push(snapshot);
    this.cleanupOldSnapshots();

    // Record memory metrics to monitoring system
    monitoring.recordApmMetric({
      name: 'memory_heap_used_mb',
      type: 'gauge',
      value: snapshot.heapUsed,
      unit: 'MB',
      timestamp: snapshot.timestamp,
    });

    monitoring.recordApmMetric({
      name: 'memory_heap_total_mb',
      type: 'gauge',
      value: snapshot.heapTotal,
      unit: 'MB',
      timestamp: snapshot.timestamp,
    });

    monitoring.recordApmMetric({
      name: 'memory_external_mb',
      type: 'gauge',
      value: snapshot.external,
      unit: 'MB',
      timestamp: snapshot.timestamp,
    });

    // Check memory thresholds
    if (snapshot.heapUsed > this.memoryThresholdMB * 0.8) { // 80% warning
      monitoring.captureMessage(
        `Memory usage high: ${snapshot.heapUsed}MB (${Math.round((snapshot.heapUsed / this.memoryThresholdMB) * 100)}%)`,
        'warning',
        { heapUsed: snapshot.heapUsed, heapTotal: snapshot.heapTotal }
      );
    }

    if (snapshot.heapUsed > this.memoryThresholdMB) { // Critical
      monitoring.captureException(
        new Error(`Memory usage exceeded threshold: ${snapshot.heapUsed}MB`),
        { heapUsed: snapshot.heapUsed, heapTotal: snapshot.heapTotal }
      );
    }
  }

  /**
   * Capture current CPU usage snapshot
   */
  private captureCpuSnapshot(): void {
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    const now = Date.now();
    const timeDelta = now - (this.cpuSnapshots[this.cpuSnapshots.length - 1]?.timestamp || now);

    const snapshot: CpuSnapshot = {
      timestamp: now,
      user: cpuUsage.user,
      system: cpuUsage.system,
    };

    this.cpuSnapshots.push(snapshot);
    this.cleanupOldSnapshots();

    // Calculate CPU percentage (rough approximation)
    const totalCpuTime = cpuUsage.user + cpuUsage.system;
    const cpuPercent = (totalCpuTime / (timeDelta * 1000)) * 100; // Convert to percentage

    monitoring.recordApmMetric({
      name: 'cpu_utilization_percent',
      type: 'gauge',
      value: Math.min(cpuPercent, 100), // Cap at 100%
      unit: 'percent',
      timestamp: snapshot.timestamp,
    });

    this.lastCpuUsage = process.cpuUsage();

    // Alert on high CPU usage
    if (cpuPercent > 80) {
      monitoring.captureMessage(
        `High CPU utilization: ${cpuPercent.toFixed(1)}%`,
        'warning',
        { cpuPercent, userTime: cpuUsage.user, systemTime: cpuUsage.system }
      );
    }
  }

  /**
   * Analyze memory usage trends
   */
  private analyzeMemoryTrends(): void {
    if (this.memorySnapshots.length < 3) return;

    const recent = this.memorySnapshots.slice(-10); // Last 10 samples
    const timeWindow = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000 / 60; // minutes
    const memoryDelta = recent[recent.length - 1].heapUsed - recent[0].heapUsed;
    const trendRate = memoryDelta / timeWindow; // MB per minute

    let trend: 'increasing' | 'decreasing' | 'stable';
    let severity: 'low' | 'medium' | 'high' | 'critical';

    if (Math.abs(trendRate) < 1) {
      trend = 'stable';
      severity = 'low';
    } else if (trendRate > 0) {
      trend = 'increasing';
      severity = trendRate > 10 ? 'critical' : trendRate > 5 ? 'high' : trendRate > 2 ? 'medium' : 'low';
    } else {
      trend = 'decreasing';
      severity = 'low';
    }

    const currentUsage = recent[recent.length - 1].heapUsed;
    const timeToThreshold = currentUsage > 0 ? 
      Math.max(0, (this.memoryThresholdMB - currentUsage) / Math.max(0.1, trendRate)) : 
      Infinity;

    const memoryTrend: MemoryTrend = {
      trend,
      rate: trendRate,
      severity,
      timeToThreshold,
    };

    monitoring.recordApmMetric({
      name: 'memory_trend_rate_mb_per_min',
      type: 'gauge',
      value: trendRate,
      unit: 'MB/min',
      timestamp: Date.now(),
      tags: { trend, severity },
    });

    // Alert on concerning trends
    if (trend === 'increasing' && severity === 'critical') {
      monitoring.captureMessage(
        `Critical memory growth trend: ${trendRate.toFixed(1)}MB/min, estimated ${Math.round(timeToThreshold)}min to threshold`,
        'critical',
        memoryTrend
      );
    }
  }

  /**
   * Detect potential memory leaks
   */
  private detectMemoryLeaks(): void {
    if (this.memorySnapshots.length < 10) return; // Need at least 10 samples

    const recent = this.memorySnapshots.slice(-20); // Last 20 samples
    const timeWindow = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000 / 60 / 60; // hours

    // Simple linear regression to detect growth
    const n = recent.length;
    const x = recent.map((_, i) => i);
    const y = recent.map(s => s.heapUsed);
    
    const xMean = x.reduce((a, b) => a + b) / n;
    const yMean = y.reduce((a, b) => a + b) / n;
    
    const numerator = x.reduce((sum, xi, i) => sum + (xi - xMean) * (y[i] - yMean), 0);
    const denominator = x.reduce((sum, xi) => sum + Math.pow(xi - xMean, 2), 0);
    
    const slope = denominator !== 0 ? numerator / denominator : 0; // MB per sample
    const growthRate = (slope * (60 / (this.samplingIntervalMs / 1000))) * 60; // MB per hour

    // Calculate R-squared for confidence
    const yPred = x.map(xi => yMean + slope * (xi - xMean));
    const ssRes = y.reduce((sum, yi, i) => sum + Math.pow(yi - yPred[i], 2), 0);
    const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const rSquared = ssTot !== 0 ? 1 - (ssRes / ssTot) : 0;
    
    const isLeaking = growthRate > 1 && rSquared > 0.7; // Growing >1MB/hr with good correlation
    const confidence = Math.round(rSquared * 100);

    const leakDetection: MemoryLeakDetection = {
      isLeaking,
      confidence,
      rate: growthRate,
      patterns: [{
        operation: 'general',
        growthRate,
        samples: n,
      }],
    };

    monitoring.recordApmMetric({
      name: 'memory_leak_detected',
      type: 'gauge',
      value: isLeaking ? 1 : 0,
      unit: 'boolean',
      timestamp: Date.now(),
      tags: { confidence: confidence.toString(), rate: growthRate.toFixed(2) },
    });

    if (isLeaking && confidence > 80) {
      monitoring.captureException(
        new Error(`Memory leak detected: ${growthRate.toFixed(1)}MB/hr with ${confidence}% confidence`),
        leakDetection
      );
    }
  }

  /**
   * Clean up old snapshots to prevent memory bloat
   */
  private cleanupOldSnapshots(): void {
    if (this.memorySnapshots.length > this.maxSnapshots) {
      this.memorySnapshots = this.memorySnapshots.slice(-this.maxSnapshots);
    }
    if (this.cpuSnapshots.length > this.maxSnapshots) {
      this.cpuSnapshots = this.cpuSnapshots.slice(-this.maxSnapshots);
    }
  }

  /**
   * Get current resource statistics
   */
  getResourceStats(): {
    memory: {
      current: MemorySnapshot;
      trend: MemoryTrend;
      leak: MemoryLeakDetection;
      snapshots: number;
    };
    cpu: {
      current: CpuSnapshot;
      utilization: number;
      snapshots: number;
    };
    uptime: number;
  } {
    const currentMemory = this.memorySnapshots[this.memorySnapshots.length - 1] || {
      timestamp: Date.now(),
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      rss: 0,
      arrayBuffers: 0,
    };

    const currentCpu = this.cpuSnapshots[this.cpuSnapshots.length - 1] || {
      timestamp: Date.now(),
      user: 0,
      system: 0,
    };

    const memoryTrend = this.calculateMemoryTrend();
    const memoryLeak = this.detectMemoryLeaksSync();

    return {
      memory: {
        current: currentMemory,
        trend: memoryTrend,
        leak: memoryLeak,
        snapshots: this.memorySnapshots.length,
      },
      cpu: {
        current: currentCpu,
        utilization: this.calculateCpuUtilization(),
        snapshots: this.cpuSnapshots.length,
      },
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * Calculate memory trend (synchronous version)
   */
  private calculateMemoryTrend(): MemoryTrend {
    if (this.memorySnapshots.length < 3) {
      return {
        trend: 'stable',
        rate: 0,
        severity: 'low',
        timeToThreshold: Infinity,
      };
    }

    const recent = this.memorySnapshots.slice(-10);
    const timeWindow = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000 / 60;
    const memoryDelta = recent[recent.length - 1].heapUsed - recent[0].heapUsed;
    const trendRate = memoryDelta / Math.max(1, timeWindow);

    let trend: 'increasing' | 'decreasing' | 'stable';
    let severity: 'low' | 'medium' | 'high' | 'critical';

    if (Math.abs(trendRate) < 1) {
      trend = 'stable';
      severity = 'low';
    } else if (trendRate > 0) {
      trend = 'increasing';
      severity = trendRate > 10 ? 'critical' : trendRate > 5 ? 'high' : trendRate > 2 ? 'medium' : 'low';
    } else {
      trend = 'decreasing';
      severity = 'low';
    }

    const currentUsage = recent[recent.length - 1].heapUsed;
    const timeToThreshold = currentUsage > 0 ? 
      Math.max(0, (this.memoryThresholdMB - currentUsage) / Math.max(0.1, trendRate)) : 
      Infinity;

    return { trend, rate: trendRate, severity, timeToThreshold };
  }

  /**
   * Calculate CPU utilization
   */
  private calculateCpuUtilization(): number {
    if (this.cpuSnapshots.length < 2) return 0;

    const recent = this.cpuSnapshots.slice(-2);
    const timeDelta = recent[1].timestamp - recent[0].timestamp;
    const userDelta = recent[1].user - recent[0].user;
    const systemDelta = recent[1].system - recent[0].system;
    const totalCpuTime = userDelta + systemDelta;

    return Math.min((totalCpuTime / (timeDelta * 1000)) * 100, 100);
  }

  /**
   * Detect memory leaks (synchronous version)
   */
  private detectMemoryLeaksSync(): MemoryLeakDetection {
    if (this.memorySnapshots.length < 10) {
      return {
        isLeaking: false,
        confidence: 0,
        rate: 0,
        patterns: [],
      };
    }

    const recent = this.memorySnapshots.slice(-20);
    const timeWindow = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000 / 60 / 60;

    // Simple linear regression
    const n = recent.length;
    const x = recent.map((_, i) => i);
    const y = recent.map(s => s.heapUsed);
    
    const xMean = x.reduce((a, b) => a + b) / n;
    const yMean = y.reduce((a, b) => a + b) / n;
    
    const numerator = x.reduce((sum, xi, i) => sum + (xi - xMean) * (y[i] - yMean), 0);
    const denominator = x.reduce((sum, xi) => sum + Math.pow(xi - xMean, 2), 0);
    
    const slope = denominator !== 0 ? numerator / denominator : 0;
    const growthRate = (slope * (60 / (this.samplingIntervalMs / 1000))) * 60; // MB per hour

    const yPred = x.map(xi => yMean + slope * (xi - xMean));
    const ssRes = y.reduce((sum, yi, i) => sum + Math.pow(yi - yPred[i], 2), 0);
    const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const rSquared = ssTot !== 0 ? 1 - (ssRes / ssTot) : 0;
    
    const isLeaking = growthRate > 1 && rSquared > 0.7;
    const confidence = Math.round(rSquared * 100);

    return {
      isLeaking,
      confidence,
      rate: growthRate,
      patterns: [{
        operation: 'general',
        growthRate,
        samples: n,
      }],
    };
  }

  /**
   * Get performance recommendations
   */
  getPerformanceRecommendations(): string[] {
    const stats = this.getResourceStats();
    const recommendations: string[] = [];

    // Memory recommendations
    if (stats.memory.trend.severity === 'critical') {
      recommendations.push('Critical memory growth detected - restart service immediately');
    } else if (stats.memory.trend.severity === 'high') {
      recommendations.push('High memory growth rate - investigate potential memory leaks');
    }

    if (stats.memory.current.heapUsed > this.memoryThresholdMB * 0.8) {
      recommendations.push('Memory usage approaching threshold - consider increasing limit or optimizing');
    }

    if (stats.memory.leak.isLeaking && stats.memory.leak.confidence > 80) {
      recommendations.push(`Memory leak detected with ${stats.memory.leak.confidence}% confidence - investigate object retention`);
    }

    // CPU recommendations
    if (stats.cpu.utilization > 80) {
      recommendations.push('High CPU utilization - consider optimizing algorithms or scaling horizontally');
    }

    // General recommendations
    if (stats.uptime > 86400) { // 24 hours
      recommendations.push('Service has been running >24h - consider scheduled restarts for memory cleanup');
    }

    return recommendations;
  }

  /**
   * Stop periodic monitoring
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Resume periodic monitoring
   */
  resume(): void {
    if (!this.monitoringInterval) {
      this.startPeriodicMonitoring();
    }
  }
}

// Global resource monitor instance
let resourceMonitor: ResourceMonitor | null = null;

/**
 * Get or create the global resource monitor
 */
export function getResourceMonitor(): ResourceMonitor {
  if (!resourceMonitor) {
    resourceMonitor = new ResourceMonitor();
  }
  return resourceMonitor;
}

/**
 * Shutdown resource monitor gracefully
 */
export function shutdownResourceMonitor(): void {
  if (resourceMonitor) {
    resourceMonitor.stop();
    resourceMonitor = null;
  }
}
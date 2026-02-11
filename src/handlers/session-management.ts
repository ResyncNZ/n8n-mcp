import { logger } from '../../utils/logger';
import { GenericObject, InstanceContext } from '../../types/common-types';

export interface SessionState {
  id: string;
  createdAt: Date;
  lastAccessedAt: Date;
  context?: InstanceContext;
  metadata?: GenericObject;
}

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private sessionTimeout: number = 30 * 60 * 1000; // 30 minutes default
  private maxSessions: number = 100;

  constructor(sessionTimeout?: number, maxSessions?: number) {
    if (sessionTimeout) {
      this.sessionTimeout = sessionTimeout;
    }
    if (maxSessions) {
      this.maxSessions = maxSessions;
    }

    // Set up periodic cleanup
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  createSession(context?: InstanceContext, metadata?: GenericObject): string {
    // Enforce maximum session limit
    if (this.sessions.size >= this.maxSessions) {
      logger.warn(`Maximum session limit (${this.maxSessions}) reached, removing oldest session`);
      this.removeOldestSession();
    }

    const sessionId = this.generateSessionId();
    const now = new Date();
    
    const sessionState: SessionState = {
      id: sessionId,
      createdAt: now,
      lastAccessedAt: now,
      context,
      metadata
    };

    this.sessions.set(sessionId, sessionState);
    
    logger.info(`Created new session: ${sessionId}`, {
      hasContext: !!context,
      hasMetadata: !!metadata,
      totalSessions: this.sessions.size
    });

    return sessionId;
  }

  getSession(sessionId: string): SessionState | null {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return null;
    }

    // Check if session has expired
    if (this.isSessionExpired(session)) {
      this.sessions.delete(sessionId);
      logger.debug(`Session expired and removed: ${sessionId}`);
      return null;
    }

    // Update last accessed time
    session.lastAccessedAt = new Date();
    return session;
  }

  updateSession(sessionId: string, updates: Partial<SessionState>): boolean {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return false;
    }

    // Check if session has expired
    if (this.isSessionExpired(session)) {
      this.sessions.delete(sessionId);
      return false;
    }

    // Update session properties
    Object.assign(session, updates);
    session.lastAccessedAt = new Date();
    
    logger.debug(`Updated session: ${sessionId}`, { updates: Object.keys(updates) });
    return true;
  }

  deleteSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    
    if (deleted) {
      logger.info(`Deleted session: ${sessionId}`, {
        remainingSessions: this.sessions.size
      });
    }
    
    return deleted;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): SessionState[] {
    const now = new Date();
    return Array.from(this.sessions.values()).filter(
      session => !this.isSessionExpired(session)
    );
  }

  exportSessionStates(): GenericObject[] {
    const activeSessions = this.getActiveSessions();
    
    return activeSessions.map(session => ({
      sessionId: session.id,
      createdAt: session.createdAt.toISOString(),
      lastAccessedAt: session.lastAccessedAt.toISOString(),
      context: session.context,
      metadata: session.metadata
    }));
  }

  restoreSessionStates(sessionData: GenericObject[]): number {
    let restoredCount = 0;
    
    for (const sessionInfo of sessionData) {
      try {
        if (!sessionInfo.sessionId) {
          logger.warn('Skipping session restoration: missing sessionId');
          continue;
        }

        // Check if session already exists
        if (this.sessions.has(sessionInfo.sessionId)) {
          logger.debug(`Skipping session restoration: session ${sessionInfo.sessionId} already exists`);
          continue;
        }

        const sessionState: SessionState = {
          id: sessionInfo.sessionId,
          createdAt: new Date(sessionInfo.createdAt || Date.now()),
          lastAccessedAt: new Date(sessionInfo.lastAccessedAt || Date.now()),
          context: sessionInfo.context,
          metadata: sessionInfo.metadata
        };

        // Skip expired sessions
        if (this.isSessionExpired(sessionState)) {
          logger.debug(`Skipping expired session restoration: ${sessionInfo.sessionId}`);
          continue;
        }

        // Enforce maximum session limit
        if (this.sessions.size >= this.maxSessions) {
          logger.warn(`Maximum session limit reached during restoration, skipping ${sessionInfo.sessionId}`);
          continue;
        }

        this.sessions.set(sessionState.id, sessionState);
        restoredCount++;
        
        logger.debug(`Restored session: ${sessionInfo.sessionId}`);
      } catch (error) {
        logger.error(`Failed to restore session:`, error);
      }
    }

    logger.info(`Session restoration completed: ${restoredCount}/${sessionData.length} sessions restored`);
    return restoredCount;
  }

  private generateSessionId(): string {
    // Generate a cryptographically random session ID
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 15);
    return `${timestamp}-${random}`;
  }

  private isSessionExpired(session: SessionState): boolean {
    const now = new Date();
    const timeSinceLastAccess = now.getTime() - session.lastAccessedAt.getTime();
    return timeSinceLastAccess > this.sessionTimeout;
  }

  private removeOldestSession(): void {
    let oldestSessionId: string | null = null;
    let oldestTime = Date.now();

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastAccessedAt.getTime() < oldestTime) {
        oldestTime = session.lastAccessedAt.getTime();
        oldestSessionId = sessionId;
      }
    }

    if (oldestSessionId) {
      this.sessions.delete(oldestSessionId);
      logger.info(`Removed oldest session: ${oldestSessionId}`);
    }
  }

  private cleanupExpiredSessions(): void {
    const beforeCount = this.sessions.size;
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (this.isSessionExpired(session)) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      this.sessions.delete(sessionId);
    }

    if (expiredSessions.length > 0) {
      logger.info(`Cleaned up ${expiredSessions.length} expired sessions`, {
        beforeCount,
        afterCount: this.sessions.size,
        expiredSessions
      });
    }
  }

  // Session statistics
  getStatistics(): GenericObject {
    const activeSessions = this.getActiveSessions();
    const totalSessions = this.sessions.size;
    const expiredCount = totalSessions - activeSessions.length;

    return {
      totalSessions,
      activeSessions: activeSessions.length,
      expiredSessions: expiredCount,
      maxSessions: this.maxSessions,
      sessionTimeout: this.sessionTimeout,
      averageSessionAge: activeSessions.length > 0 
        ? this.calculateAverageAge(activeSessions)
        : 0
    };
  }

  private calculateAverageAge(sessions: SessionState[]): number {
    if (sessions.length === 0) return 0;
    
    const now = new Date();
    const totalAge = sessions.reduce((sum, session) => {
      return sum + (now.getTime() - session.createdAt.getTime());
    }, 0);
    
    return totalAge / sessions.length;
  }
}
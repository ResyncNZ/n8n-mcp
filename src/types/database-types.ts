/**
 * Database-specific type definitions for node repository
 *
 * This file provides strong typing for database operations,
 * replacing 'any' types with specific interfaces.
 *
 * @module types/database-types
 */

import type { NodeProperty, NodeOperation, NodeCredential } from './common-types';

/**
 * Represents a parsed node from the database
 */
export interface ParsedNodeRow {
  nodeType: string;
  displayName: string;
  description: string;
  category: string;
  developmentStyle: string;
  package: string;
  isAITool: boolean;
  isTrigger: boolean;
  isWebhook: boolean;
  isVersioned: boolean;
  isToolVariant: boolean;
  toolVariantOf: string | null;
  hasToolVariant: boolean;
  version: string;
  properties: NodeProperty[];
  operations: NodeOperation[];
  credentials: NodeCredential[];
  hasDocumentation: boolean;
  outputs: unknown;
  outputNames: string[] | null;
  // Community node fields
  isCommunity: boolean;
  isVerified: boolean;
  authorName: string | null;
  authorGithubUrl: string | null;
  npmPackageName: string | null;
  npmVersion: string | null;
  npmDownloads: number;
  communityFetchedAt: string | null;
  // AI documentation fields
  npmReadme: string | null;
  aiDocumentationSummary: unknown;
  aiSummaryGeneratedAt: string | null;
}

/**
 * Represents an AI tool summary (lightweight version)
 */
export interface AIToolSummary {
  nodeType: string;
  displayName: string;
  description: string;
  package: string;
}

/**
 * Represents a tool variant summary
 */
export interface ToolVariantSummary {
  nodeType: string;
  displayName: string;
  description: string;
  package: string;
  toolVariantOf: string;
}

/**
 * Represents a property search result
 */
export interface PropertySearchResult {
  path: string;
  property: NodeProperty;
  description?: string;
}

/**
 * Community node stats
 */
export interface CommunityStats {
  total: number;
  verified: number;
  unverified: number;
}

/**
 * Documentation statistics
 */
export interface DocumentationStats {
  total: number;
  withReadme: number;
  withAISummary: number;
  needingReadme: number;
  needingAISummary: number;
}

/**
 * Represents a node version from the database
 */
export interface NodeVersionRow {
  id: number;
  nodeType: string;
  version: string;
  packageName: string;
  displayName: string;
  description: string;
  category: string;
  isCurrentMax: boolean;
  propertiesSchema: NodeProperty[] | null;
  operations: NodeOperation[] | null;
  credentialsRequired: NodeCredential[] | null;
  outputs: unknown;
  minimumN8nVersion: string;
  breakingChanges: BreakingChangeData[];
  deprecatedProperties: string[];
  addedProperties: string[];
  releasedAt: string;
  createdAt: string;
}

/**
 * Breaking change data structure
 */
export interface BreakingChangeData {
  property?: string;
  description: string;
  migration?: string;
  [key: string]: unknown;
}

/**
 * Property change between versions
 */
export interface PropertyChangeRow {
  id: number;
  nodeType: string;
  fromVersion: string;
  toVersion: string;
  propertyName: string;
  changeType: 'added' | 'removed' | 'renamed' | 'type_changed' | 'requirement_changed' | 'default_changed';
  isBreaking: boolean;
  oldValue: string;
  newValue: string;
  migrationHint: string;
  autoMigratable: boolean;
  migrationStrategy: unknown;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  createdAt: string;
}

/**
 * Workflow version from database
 */
export interface WorkflowVersionRow {
  id: number;
  workflowId: string;
  versionNumber: number;
  workflowName: string;
  workflowSnapshot: unknown;
  trigger: 'partial_update' | 'full_update' | 'autofix';
  operations: unknown[] | null;
  fixTypes: string[] | null;
  metadata: unknown;
  createdAt: string;
}

/**
 * Workflow storage statistics
 */
export interface WorkflowStorageStats {
  totalVersions: number;
  totalSize: number;
  byWorkflow: WorkflowStatsEntry[];
}

/**
 * Per-workflow storage stats entry
 */
export interface WorkflowStatsEntry {
  workflowId: string;
  workflowName: string;
  versionCount: number;
  totalSize: number;
  lastBackup: string;
}

/**
 * Database row type (generic structure from SQLite)
 */
export interface DatabaseRow {
  [column: string]: string | number | null | Buffer;
}

/**
 * Database count result
 */
export interface CountResult {
  count: number;
}

/**
 * Database size result
 */
export interface SizeResult {
  total_size: number | null;
}

/**
 * SQL parameter array (for prepared statements)
 */
export type SqlParameters = (string | number | boolean | null)[];

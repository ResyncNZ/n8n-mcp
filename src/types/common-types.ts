/**
 * Common type definitions to replace 'any' types across the codebase
 *
 * This file provides strong typing for frequently used structures
 * in n8n node documentation and workflow management.
 *
 * @module types/common-types
 */

import type { IDataObject, INodeParameters } from 'n8n-workflow';

/**
 * Display options for conditional property visibility
 */
export interface DisplayOptions {
  show?: Record<string, string | string[] | unknown>;
  hide?: Record<string, string | string[] | unknown>;
  [key: string]: unknown;
}

/**
 * Represents a node property (form field, configuration option, etc.)
 */
export interface NodeProperty {
  name: string;
  displayName: string;
  type: string;
  default?: unknown;
  required?: boolean;
  description?: string;
  options?: NodePropertyOption[];
  displayOptions?: DisplayOptions;
  [key: string]: unknown; // Allow additional properties
}

/**
 * Represents an option in a dropdown or multi-select property
 */
export interface NodePropertyOption {
  name: string;
  value: string | number | boolean;
  description?: string;
  action?: string;
  [key: string]: unknown;
}

/**
 * Represents a node operation (action the node can perform)
 */
export interface NodeOperation {
  name: string;
  value: string;
  description?: string;
  action?: string;
  [key: string]: unknown;
}

/**
 * Represents credential requirements for a node
 */
export interface NodeCredential {
  name: string;
  required?: boolean;
  displayOptions?: Record<string, unknown>;
  testedBy?: string;
  [key: string]: unknown;
}

/**
 * Represents an example workflow or usage
 */
export interface NodeExample {
  name?: string;
  description?: string;
  workflow?: IDataObject;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * Represents a version change in a node
 */
export interface VersionChange {
  version: string;
  description: string;
  breaking?: boolean;
  properties?: string[];
  type?: 'added' | 'removed' | 'modified' | 'deprecated';
  [key: string]: unknown;
}

/**
 * Represents a breaking change between versions
 */
export interface BreakingChange extends VersionChange {
  breaking: true;
  migration?: string;
  impact?: 'high' | 'medium' | 'low';
}

/**
 * Represents a migration guide for version upgrades
 */
export interface Migration {
  fromVersion: string;
  toVersion: string;
  description: string;
  steps?: string[];
  automated?: boolean;
  [key: string]: unknown;
}

/**
 * Generic object type (better than 'any' for unknown structures)
 */
export type GenericObject = Record<string, unknown>;

/**
 * Tool arguments (JSON object with unknown structure)
 */
export type ToolArguments = IDataObject;

/**
 * Tool result (can be any JSON-serializable value)
 */
export type ToolResult = unknown;

/**
 * Validation result (successful or error)
 */
export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
}

/**
 * Validation error details
 */
export interface ValidationError {
  field?: string;
  message: string;
  code?: string;
  severity?: 'error' | 'critical';
}

/**
 * Validation warning details
 */
export interface ValidationWarning {
  field?: string;
  message: string;
  code?: string;
}

/**
 * Type guard to check if a value is a valid object
 */
export function isObject(value: unknown): value is GenericObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if a value is an array
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Type guard to check if a value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Type guard to check if a value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/**
 * Safely parse JSON with type checking
 */
export function parseJSON<T = unknown>(json: string, fallback?: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback as T;
  }
}

/**
 * Safely stringify JSON
 */
export function stringifyJSON(value: unknown, pretty = false): string {
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0);
  } catch {
    return '';
  }
}

// ============================================
// MCP-Specific Types (for bridge.ts)
// ============================================

/**
 * MCP tool content item
 */
export interface MCPContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * MCP tool response structure
 */
export interface MCPResponse {
  content: MCPContentItem[];
  [key: string]: unknown;
}

/**
 * MCP workflow format
 */
export interface MCPWorkflow {
  id?: string;
  name: string;
  description?: string;
  nodes: MCPWorkflowNode[];
  connections: GenericObject;
  settings?: GenericObject;
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    active?: boolean;
  };
}

/**
 * MCP workflow node (simplified)
 */
export interface MCPWorkflowNode {
  id: string;
  type: string;
  name: string;
  parameters?: GenericObject;
  position?: [number, number];
  [key: string]: unknown;
}

/**
 * MCP resource representation
 */
export interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  data: GenericObject;
}

/**
 * MCP prompt arguments
 */
export interface MCPPromptArgs {
  name?: string;
  arguments?: GenericObject;
  messages?: unknown[];
  [key: string]: unknown;
}

/**
 * n8n workflow structure
 */
export interface N8NWorkflow {
  id?: string;
  name: string;
  description?: string;
  nodes: N8NWorkflowNode[];
  connections: GenericObject;
  settings?: GenericObject;
  staticData?: unknown;
  pinData?: GenericObject;
  createdAt?: string;
  updatedAt?: string;
  active?: boolean;
  [key: string]: unknown;
}

/**
 * n8n workflow node
 */
export interface N8NWorkflowNode {
  id: string;
  name: string;
  type: string;
  parameters?: GenericObject;
  credentials?: GenericObject;
  position?: [number, number];
  disabled?: boolean;
  typeVersion?: number;
  [key: string]: unknown;
}

/**
 * n8n execution data
 */
export interface N8NExecution {
  id: string;
  workflowId?: string;
  workflowData?: {
    name?: string;
    [key: string]: unknown;
  };
  finished?: boolean;
  stoppedAt?: string;
  mode?: string;
  startedAt?: string;
  data?: {
    resultData?: {
      error?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Error with additional properties
 */
export interface ErrorWithDetails extends Error {
  code?: string;
  statusCode?: number;
  data?: unknown;
}

// ============================================
// Workflow Sanitizer Types
// ============================================

/**
 * Workflow connection structure
 */
export interface WorkflowConnection {
  node: string;
  type: string;
  index: number;
}

/**
 * Node connections map
 */
export type NodeConnectionsMap = Record<string, WorkflowConnection[][]>;

/**
 * Sanitized workflow node (sensitive data removed)
 */
export interface SanitizedWorkflowNode {
  id: string;
  name: string;
  type: string;
  position: [number, number];
  parameters: GenericObject;
  disabled?: boolean;
  typeVersion?: number;
  [key: string]: unknown;
}

/**
 * Sanitized workflow structure
 */
export interface SanitizedWorkflowStructure {
  nodes: SanitizedWorkflowNode[];
  connections: GenericObject;
  nodeCount: number;
  nodeTypes: string[];
  hasTrigger: boolean;
  hasWebhook: boolean;
  complexity: 'simple' | 'medium' | 'complex';
  workflowHash: string;
}

// ============================================
// Database Query Result Types
// ============================================

/**
 * Template example from database query
 */
export interface TemplateExample {
  parameters_json: string;
  template_name: string;
  template_views?: number;
}

/**
 * Mapped template example for node results
 */
export interface MappedTemplateExample {
  configuration: unknown;
  template: string;
  views?: number;
}

/**
 * Property mapping result
 */
export interface PropertyMappingResult {
  name: string;
  displayName: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

/**
 * Operation mapping result
 */
export interface OperationMappingResult {
  name: string;
  displayName?: string;
  description?: string;
  action?: string;
  value?: string;
}

/**
 * Search match result
 */
export interface SearchMatch {
  nodeType: string;
  displayName: string;
  description?: string;
  category?: string;
  score?: number;
}

/**
 * Version history entry
 */
export interface VersionHistoryEntry {
  version: string;
  description?: string;
  breaking?: boolean;
  type?: 'added' | 'removed' | 'modified' | 'deprecated';
  properties?: string[];
}

/**
 * AI tool example structure
 */
export interface AIToolExample {
  name?: string;
  description?: string;
  configuration?: unknown;
  workflow?: unknown;
}

/**
 * Transport interface for MCP server
 */
export interface MCPTransport {
  close?: () => Promise<void> | void;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  [key: string]: unknown;
}

/**
 * Workflow validation options
 */
export interface WorkflowValidationOptions {
  checkConnections?: boolean;
  checkExpressions?: boolean;
  strict?: boolean;
  profile?: 'minimal' | 'runtime' | 'ai-friendly' | 'strict';
}

/**
 * Workflow validation response
 */
export interface WorkflowValidationResponse {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
  statistics?: {
    totalNodes: number;
    triggerNodes: number;
    validConnections: number;
    invalidConnections: number;
    expressionsValidated: number;
  };
  summary?: {
    totalNodes: number;
    enabledNodes: number;
    triggerNodes: number;
    validConnections: number;
    invalidConnections: number;
    expressionsValidated: number;
    errorCount: number;
    warningCount: number;
  };
}

/**
 * Process stdout write function signature
 */
export type StdoutWriteFunction = (
  chunk: Buffer | string,
  encoding?: BufferEncoding | null,
  callback?: ((error?: Error | null) => void) | null
) => boolean;

/**
 * Search result node with optional community metadata
 */
export interface SearchResultNode {
  nodeType: string;
  workflowNodeType: string;
  displayName: string;
  description?: string;
  category?: string;
  package: string;
  isCommunity?: boolean;
  isVerified?: boolean;
  authorName?: string;
  npmDownloads?: number;
}

/**
 * Extended NodeRow with community fields
 */
export interface ExtendedNodeRow extends NodeRow {
  is_community?: number;
  is_verified?: number;
  author_name?: string;
  npm_downloads?: number;
}

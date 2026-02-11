import { NodeProperty, NodeOperation, NodeCredential, NodeExample, VersionChange, BreakingChange, Migration, GenericObject } from '../../types/common-types';

export interface NodeRow {
  node_type: string;
  package_name: string;
  display_name: string;
  description?: string;
  category?: string;
  development_style?: string;
  is_ai_tool: number;
  is_trigger: number;
  is_webhook: number;
  is_versioned: number;
  is_tool_variant: number;
  tool_variant_of?: string;
  has_tool_variant: number;
  version?: string;
  documentation?: string;
  properties_schema?: string;
  operations?: string;
  credentials_required?: string;
  ai_documentation_summary?: string;
  ai_summary_generated_at?: string;
}

export interface VersionSummary {
  currentVersion: string;
  totalVersions: number;
  hasVersionHistory: boolean;
}

export interface ToolVariantGuidance {
  isToolVariant: boolean;
  toolVariantOf?: string;
  hasToolVariant: boolean;
  toolVariantNodeType?: string;
  guidance?: string;
}

export interface NodeMinimalInfo {
  nodeType: string;
  workflowNodeType: string;
  displayName: string;
  description: string;
  category: string;
  package: string;
  isAITool: boolean;
  isTrigger: boolean;
  isWebhook: boolean;
  toolVariantInfo?: ToolVariantGuidance;
}

export interface NodeStandardInfo {
  nodeType: string;
  displayName: string;
  description: string;
  category: string;
  requiredProperties: NodeProperty[];
  commonProperties: NodeProperty[];
  operations?: NodeOperation[];
  credentials?: NodeCredential;
  examples?: NodeExample[];
  versionInfo: VersionSummary;
  toolVariantInfo?: ToolVariantGuidance;
}

export interface NodeFullInfo {
  nodeType: string;
  displayName: string;
  description: string;
  category: string;
  properties: NodeProperty[];
  operations?: NodeOperation[];
  credentials?: NodeCredential;
  documentation?: string;
  versionInfo: VersionSummary;
  toolVariantInfo?: ToolVariantGuidance;
}

export interface VersionHistoryInfo {
  nodeType: string;
  versions: VersionChange[];
  latestVersion: string;
  hasBreakingChanges: boolean;
}

export interface VersionComparisonInfo {
  nodeType: string;
  fromVersion: string;
  toVersion: string;
  changes: VersionChange[];
  breakingChanges?: BreakingChange[];
  migrations?: Migration[];
}

export type NodeInfoResponse = NodeMinimalInfo | NodeStandardInfo | NodeFullInfo | VersionHistoryInfo | VersionComparisonInfo;

export interface SearchOptions {
  mode?: 'OR' | 'AND' | 'FUZZY';
  includeSource?: boolean;
  includeExamples?: boolean;
  source?: 'all' | 'core' | 'community' | 'verified';
}

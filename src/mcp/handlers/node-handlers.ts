import { NodeRepository } from '../../database/node-repository';
import { DatabaseAdapter } from '../../database/database-adapter';
import { PropertyFilter } from '../../services/property-filter';
import { ConfigValidator } from '../../services/config-validator';
import { EnhancedConfigValidator, ValidationMode, ValidationProfile } from '../../services/enhanced-config-validator';
import { TypeStructureService } from '../../services/type-structure-service';
import { NodeTypeNormalizer } from '../../utils/node-type-normalizer';
import { getNodeTypeAlternatives, getWorkflowNodeType } from '../../utils/node-utils';
import { logger } from '../../utils/logger';
import { SimpleCache } from '../../utils/simple-cache';
import { 
  NodeRow, 
  NodeMinimalInfo, 
  NodeStandardInfo, 
  NodeFullInfo, 
  NodeInfoResponse,
  VersionSummary,
  ToolVariantGuidance 
} from './types';
import { 
  safeJsonParse, 
  getOutputDescriptions, 
  getCommonAIToolUseCases,
  buildToolVariantGuidance,
  getAIToolExamples
} from './utility-handlers';

export interface NodeHandlerDeps {
  db: DatabaseAdapter;
  repository: NodeRepository;
  cache: SimpleCache;
}

/**
 * Get node information (full details)
 */
export async function getNodeInfo(
  nodeType: string,
  deps: NodeHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;

  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
  let node = repository.getNode(normalizedType);
  
  if (!node && normalizedType !== nodeType) {
    node = repository.getNode(nodeType);
  }
  
  if (!node) {
    const alternatives = getNodeTypeAlternatives(normalizedType);
    
    for (const alt of alternatives) {
      const found = repository.getNode(alt);
      if (found) {
        node = found;
        break;
      }
    }
  }
  
  if (!node) {
    throw new Error(`Node ${nodeType} not found`);
  }
  
  const aiToolCapabilities = {
    canBeUsedAsTool: true,
    hasUsableAsToolProperty: node.isAITool ?? false,
    requiresEnvironmentVariable: !(node.isAITool ?? false) && node.package !== 'n8n-nodes-base',
    toolConnectionType: 'ai_tool',
    commonToolUseCases: getCommonAIToolUseCases(node.nodeType),
    environmentRequirement: node.package && node.package !== 'n8n-nodes-base' ?
      'N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true' :
      null
  };

  let outputs = undefined;
  if (node.outputNames && Array.isArray(node.outputNames) && node.outputNames.length > 0) {
    outputs = node.outputNames.map((name: string, index: number) => {
      const descriptions = getOutputDescriptions(node.nodeType, name, index);
      return {
        index,
        name,
        description: descriptions?.description ?? '',
        connectionGuidance: descriptions?.connectionGuidance ?? ''
      };
    });
  }

  const result: Record<string, unknown> = {
    ...node,
    workflowNodeType: getWorkflowNodeType(node.package ?? 'n8n-nodes-base', node.nodeType),
    aiToolCapabilities,
    outputs
  };

  const toolVariantInfo = buildToolVariantGuidance(node);
  if (toolVariantInfo) {
    result.toolVariantInfo = toolVariantInfo;
  }

  return result;
}

/**
 * Get node essentials (filtered properties)
 */
export async function getNodeEssentials(
  nodeType: string,
  includeExamples: boolean | undefined,
  deps: NodeHandlerDeps
): Promise<Record<string, unknown>> {
  const { db, repository, cache } = deps;

  const cacheKey = `essentials:${nodeType}:${includeExamples ? 'withExamples' : 'basic'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
  let node = repository.getNode(normalizedType);
  
  if (!node && normalizedType !== nodeType) {
    node = repository.getNode(nodeType);
  }
  
  if (!node) {
    const alternatives = getNodeTypeAlternatives(normalizedType);
    
    for (const alt of alternatives) {
      const found = repository.getNode(alt);
      if (found) {
        node = found;
        break;
      }
    }
  }
  
  if (!node) {
    throw new Error(`Node ${nodeType} not found`);
  }
  
  const allProperties = node.properties || [];
  const essentials = PropertyFilter.getEssentials(allProperties, node.nodeType);
  const operations = node.operations || [];
  const latestVersion = node.version ?? '1';

  const result: Record<string, unknown> = {
    nodeType: node.nodeType,
    workflowNodeType: getWorkflowNodeType(node.package ?? 'n8n-nodes-base', node.nodeType),
    displayName: node.displayName,
    description: node.description,
    category: node.category,
    version: latestVersion,
    isVersioned: node.isVersioned ?? false,
    versionNotice: `⚠️ Use typeVersion: ${latestVersion} when creating this node`,
    requiredProperties: essentials.required,
    commonProperties: essentials.common,
    operations: operations.map((op: Record<string, unknown>) => ({
      name: op.name || op.operation,
      description: op.description,
      action: op.action,
      resource: op.resource
    })),
    metadata: {
      totalProperties: allProperties.length,
      isAITool: node.isAITool ?? false,
      isTrigger: node.isTrigger ?? false,
      isWebhook: node.isWebhook ?? false,
      hasCredentials: node.credentials ? true : false,
      package: node.package ?? 'n8n-nodes-base',
      developmentStyle: node.developmentStyle ?? 'programmatic'
    }
  };

  const toolVariantInfo = buildToolVariantGuidance(node);
  if (toolVariantInfo) {
    result.toolVariantInfo = toolVariantInfo;
  }

  if (includeExamples) {
    try {
      const examples = db.prepare(`
        SELECT
          parameters_json,
          template_name,
          template_views,
          complexity,
          use_cases,
          has_credentials,
          has_expressions
        FROM template_node_configs
        WHERE node_type = ?
        ORDER BY rank
        LIMIT 3
      `).all(result.workflowNodeType as string) as Array<{
        parameters_json: string;
        template_name: string;
        template_views: number;
        complexity: string;
        use_cases: string;
        has_credentials: number;
        has_expressions: number;
      }>;

      if (examples.length > 0) {
        (result as Record<string, unknown>).examples = examples.map((ex) => ({
          configuration: JSON.parse(ex.parameters_json),
          source: {
            template: ex.template_name,
            views: ex.template_views,
            complexity: ex.complexity
          },
          useCases: ex.use_cases ? JSON.parse(ex.use_cases).slice(0, 2) : [],
          metadata: {
            hasCredentials: ex.has_credentials === 1,
            hasExpressions: ex.has_expressions === 1
          }
        }));
        (result as Record<string, unknown>).examplesCount = examples.length;
      } else {
        (result as Record<string, unknown>).examples = [];
        (result as Record<string, unknown>).examplesCount = 0;
      }
    } catch (error: unknown) {
      logger.warn(`Failed to fetch examples for ${nodeType}:`, (error as Error).message);
      (result as Record<string, unknown>).examples = [];
      (result as Record<string, unknown>).examplesCount = 0;
    }
  }

  cache.set(cacheKey, result, 3600);
  return result;
}

/**
 * Get node documentation
 */
export async function getNodeDocumentation(
  nodeType: string,
  deps: NodeHandlerDeps
): Promise<Record<string, unknown>> {
  const { db } = deps;

  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
  let node = db.prepare(`
    SELECT node_type, display_name, documentation, description,
           ai_documentation_summary, ai_summary_generated_at
    FROM nodes
    WHERE node_type = ?
  `).get(normalizedType) as NodeRow | undefined;

  if (!node && normalizedType !== nodeType) {
    node = db.prepare(`
      SELECT node_type, display_name, documentation, description,
             ai_documentation_summary, ai_summary_generated_at
      FROM nodes
      WHERE node_type = ?
    `).get(nodeType) as NodeRow | undefined;
  }

  if (!node) {
    const alternatives = getNodeTypeAlternatives(normalizedType);

    for (const alt of alternatives) {
      node = db.prepare(`
        SELECT node_type, display_name, documentation, description,
               ai_documentation_summary, ai_summary_generated_at
        FROM nodes
        WHERE node_type = ?
      `).get(alt) as NodeRow | undefined;

      if (node) break;
    }
  }
  
  if (!node) {
    throw new Error(`Node ${nodeType} not found`);
  }
  
  const aiDocSummary = node.ai_documentation_summary
    ? safeJsonParse(node.ai_documentation_summary, null)
    : null;

  if (!node.documentation) {
    const essentials = await getNodeEssentials(nodeType, false, deps);
    const commonProps = (essentials.commonProperties as Array<Record<string, unknown>>) || [];

    return {
      nodeType: node.node_type,
      displayName: node.display_name || 'Unknown Node',
      documentation: `
# ${node.display_name || 'Unknown Node'}

${node.description || 'No description available.'}

## Common Properties

${commonProps.length > 0 ?
  commonProps.map((p) =>
    `### ${p.displayName || 'Property'}\n${p.description || `Type: ${p.type || 'unknown'}`}`
  ).join('\n\n') :
  'No common properties available.'}

## Note
Full documentation is being prepared. For now, use get_node_essentials for configuration help.
`,
      hasDocumentation: false,
      aiDocumentationSummary: aiDocSummary,
      aiSummaryGeneratedAt: node.ai_summary_generated_at || null,
    };
  }

  return {
    nodeType: node.node_type,
    displayName: node.display_name || 'Unknown Node',
    documentation: node.documentation,
    hasDocumentation: true,
    aiDocumentationSummary: aiDocSummary,
    aiSummaryGeneratedAt: node.ai_summary_generated_at || null,
  };
}

/**
 * Unified node information retrieval with multiple detail levels and modes
 */
export async function getNode(
  nodeType: string,
  detail: string,
  mode: string,
  includeTypeInfo: boolean | undefined,
  includeExamples: boolean | undefined,
  fromVersion: string | undefined,
  toVersion: string | undefined,
  deps: NodeHandlerDeps
): Promise<NodeInfoResponse> {
  const { repository, cache } = deps;

  const validDetailLevels = ['minimal', 'standard', 'full'];
  const validModes = ['info', 'versions', 'compare', 'breaking', 'migrations'];

  if (!validDetailLevels.includes(detail)) {
    throw new Error(`get_node: Invalid detail level "${detail}". Valid options: ${validDetailLevels.join(', ')}`);
  }

  if (!validModes.includes(mode)) {
    throw new Error(`get_node: Invalid mode "${mode}". Valid options: ${validModes.join(', ')}`);
  }

  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);

  if (mode !== 'info') {
    return handleVersionMode(normalizedType, mode, fromVersion, toVersion, deps);
  }

  return handleInfoMode(normalizedType, detail, includeTypeInfo, includeExamples, deps);
}

/**
 * Handle info mode - returns node information at specified detail level
 */
async function handleInfoMode(
  nodeType: string,
  detail: string,
  includeTypeInfo: boolean | undefined,
  includeExamples: boolean | undefined,
  deps: NodeHandlerDeps
): Promise<NodeMinimalInfo | NodeStandardInfo | NodeFullInfo> {
  const { repository } = deps;

  switch (detail) {
    case 'minimal': {
      let node = repository.getNode(nodeType);

      if (!node) {
        const alternatives = getNodeTypeAlternatives(nodeType);
        for (const alt of alternatives) {
          const found = repository.getNode(alt);
          if (found) {
            node = found;
            break;
          }
        }
      }

      if (!node) {
        throw new Error(`Node ${nodeType} not found`);
      }

      const result: NodeMinimalInfo = {
        nodeType: node.nodeType,
        workflowNodeType: getWorkflowNodeType(node.package ?? 'n8n-nodes-base', node.nodeType),
        displayName: node.displayName,
        description: node.description,
        category: node.category,
        package: node.package,
        isAITool: node.isAITool,
        isTrigger: node.isTrigger,
        isWebhook: node.isWebhook
      };

      const toolVariantInfo = buildToolVariantGuidance(node);
      if (toolVariantInfo) {
        result.toolVariantInfo = toolVariantInfo;
      }

      return result;
    }

    case 'standard': {
      const essentials = await getNodeEssentials(nodeType, includeExamples, deps);
      const versionSummary = getVersionSummary(nodeType, deps);

      if (includeTypeInfo) {
        essentials.requiredProperties = enrichPropertiesWithTypeInfo(essentials.requiredProperties as NodeInfoResponse[]);
        essentials.commonProperties = enrichPropertiesWithTypeInfo(essentials.commonProperties as NodeInfoResponse[]);
      }

      return {
        ...essentials,
        versionInfo: versionSummary
      } as NodeStandardInfo;
    }

    case 'full': {
      const fullInfo = await getNodeInfo(nodeType, deps);
      const versionSummary = getVersionSummary(nodeType, deps);

      if (includeTypeInfo && fullInfo.properties) {
        fullInfo.properties = enrichPropertiesWithTypeInfo(fullInfo.properties as NodeInfoResponse[]);
      }

      return {
        ...fullInfo,
        versionInfo: versionSummary
      } as NodeFullInfo;
    }

    default:
      throw new Error(`Unknown detail level: ${detail}`);
  }
}

/**
 * Handle version modes - returns version history and comparison data
 */
async function handleVersionMode(
  nodeType: string,
  mode: string,
  fromVersion: string | undefined,
  toVersion: string | undefined,
  deps: NodeHandlerDeps
): Promise<NodeInfoResponse> {
  switch (mode) {
    case 'versions':
      return getVersionHistory(nodeType, deps);

    case 'compare':
      if (!fromVersion) {
        throw new Error(`get_node: fromVersion is required for compare mode (nodeType: ${nodeType})`);
      }
      return compareVersions(nodeType, fromVersion, toVersion, deps);

    case 'breaking':
      if (!fromVersion) {
        throw new Error(`get_node: fromVersion is required for breaking mode (nodeType: ${nodeType})`);
      }
      return getBreakingChanges(nodeType, fromVersion, toVersion, deps);

    case 'migrations':
      if (!fromVersion || !toVersion) {
        throw new Error(`get_node: Both fromVersion and toVersion are required for migrations mode (nodeType: ${nodeType})`);
      }
      return getMigrations(nodeType, fromVersion, toVersion, deps);

    default:
      throw new Error(`get_node: Unknown mode: ${mode} (nodeType: ${nodeType})`);
  }
}

/**
 * Get version summary (always included in info mode responses)
 */
function getVersionSummary(nodeType: string, deps: NodeHandlerDeps): VersionSummary {
  const { repository, cache } = deps;
  const cacheKey = `version-summary:${nodeType}`;
  const cached = cache.get(cacheKey) as VersionSummary | null;

  if (cached) {
    return cached;
  }

  const versions = repository.getNodeVersions(nodeType);
  const latest = repository.getLatestNodeVersion(nodeType);

  const summary: VersionSummary = {
    currentVersion: latest?.version || 'unknown',
    totalVersions: versions.length,
    hasVersionHistory: versions.length > 0
  };

  cache.set(cacheKey, summary, 86400000);
  return summary;
}

/**
 * Get complete version history for a node
 */
function getVersionHistory(nodeType: string, deps: NodeHandlerDeps): Record<string, unknown> {
  const { repository } = deps;
  const versions = repository.getNodeVersions(nodeType);

  return {
    nodeType,
    totalVersions: versions.length,
    versions: versions.map(v => ({
      version: v.version,
      isCurrent: v.isCurrentMax,
      minimumN8nVersion: v.minimumN8nVersion,
      releasedAt: v.releasedAt,
      hasBreakingChanges: (v.breakingChanges || []).length > 0,
      breakingChangesCount: (v.breakingChanges || []).length,
      deprecatedProperties: v.deprecatedProperties || [],
      addedProperties: v.addedProperties || []
    })),
    available: versions.length > 0,
    message: versions.length === 0 ?
      'No version history available. Version tracking may not be enabled for this node.' :
      undefined
  };
}

/**
 * Compare two versions of a node
 */
function compareVersions(
  nodeType: string,
  fromVersion: string,
  toVersion: string | undefined,
  deps: NodeHandlerDeps
): Record<string, unknown> {
  const { repository } = deps;
  const latest = repository.getLatestNodeVersion(nodeType);
  const targetVersion = toVersion || latest?.version;

  if (!targetVersion) {
    throw new Error('No target version available');
  }

  const changes = repository.getPropertyChanges(nodeType, fromVersion, targetVersion);

  return {
    nodeType,
    fromVersion,
    toVersion: targetVersion,
    totalChanges: changes.length,
    breakingChanges: changes.filter(c => c.isBreaking).length,
    changes: changes.map(c => ({
      property: c.propertyName,
      changeType: c.changeType,
      isBreaking: c.isBreaking,
      severity: c.severity,
      oldValue: c.oldValue,
      newValue: c.newValue,
      migrationHint: c.migrationHint,
      autoMigratable: c.autoMigratable
    }))
  };
}

/**
 * Get breaking changes between versions
 */
function getBreakingChanges(
  nodeType: string,
  fromVersion: string,
  toVersion: string | undefined,
  deps: NodeHandlerDeps
): Record<string, unknown> {
  const { repository } = deps;
  const breakingChanges = repository.getBreakingChanges(nodeType, fromVersion, toVersion);

  return {
    nodeType,
    fromVersion,
    toVersion: toVersion || 'latest',
    totalBreakingChanges: breakingChanges.length,
    changes: breakingChanges.map(c => ({
      fromVersion: c.fromVersion,
      toVersion: c.toVersion,
      property: c.propertyName,
      changeType: c.changeType,
      severity: c.severity,
      migrationHint: c.migrationHint,
      oldValue: c.oldValue,
      newValue: c.newValue
    })),
    upgradeSafe: breakingChanges.length === 0
  };
}

/**
 * Get auto-migratable changes between versions
 */
function getMigrations(
  nodeType: string,
  fromVersion: string,
  toVersion: string,
  deps: NodeHandlerDeps
): Record<string, unknown> {
  const { repository } = deps;
  const migrations = repository.getAutoMigratableChanges(nodeType, fromVersion, toVersion);
  const allChanges = repository.getPropertyChanges(nodeType, fromVersion, toVersion);

  return {
    nodeType,
    fromVersion,
    toVersion,
    autoMigratableChanges: migrations.length,
    totalChanges: allChanges.length,
    migrations: migrations.map(m => ({
      property: m.propertyName,
      changeType: m.changeType,
      migrationStrategy: m.migrationStrategy,
      severity: m.severity
    })),
    requiresManualMigration: migrations.length < allChanges.length
  };
}

/**
 * Enrich property with type structure metadata
 */
function enrichPropertyWithTypeInfo(property: Record<string, unknown>): Record<string, unknown> {
  if (!property || !property.type) return property;

  const structure = TypeStructureService.getStructure(property.type as string);
  if (!structure) return property;

  return {
    ...property,
    typeInfo: {
      category: structure.type,
      jsType: structure.jsType,
      description: structure.description,
      isComplex: TypeStructureService.isComplexType(property.type as string),
      isPrimitive: TypeStructureService.isPrimitiveType(property.type as string),
      allowsExpressions: structure.validation?.allowExpressions ?? true,
      allowsEmpty: structure.validation?.allowEmpty ?? false,
      ...(structure.structure && {
        structureHints: {
          hasProperties: !!structure.structure.properties,
          hasItems: !!structure.structure.items,
          isFlexible: structure.structure.flexible ?? false,
          requiredFields: structure.structure.required ?? []
        }
      }),
      ...(structure.notes && { notes: structure.notes })
    }
  };
}

/**
 * Enrich an array of properties with type structure metadata
 */
function enrichPropertiesWithTypeInfo(properties: unknown[]): unknown[] {
  if (!properties || !Array.isArray(properties)) return properties;
  return properties.map((prop) => enrichPropertyWithTypeInfo(prop as Record<string, unknown>));
}

/**
 * Search node properties
 */
export async function searchNodeProperties(
  nodeType: string,
  query: string,
  maxResults: number,
  deps: NodeHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;

  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
  let node = repository.getNode(normalizedType);
  
  if (!node && normalizedType !== nodeType) {
    node = repository.getNode(nodeType);
  }
  
  if (!node) {
    const alternatives = getNodeTypeAlternatives(normalizedType);
    
    for (const alt of alternatives) {
      const found = repository.getNode(alt);
      if (found) {
        node = found;
        break;
      }
    }
  }
  
  if (!node) {
    throw new Error(`Node ${nodeType} not found`);
  }
  
  const allProperties = node.properties || [];
  const matches = PropertyFilter.searchProperties(allProperties, query, maxResults);
  
  return {
    nodeType: node.nodeType,
    query,
    matches: matches.map((match: Record<string, unknown>) => ({
      name: match.name,
      displayName: match.displayName,
      type: match.type,
      description: match.description,
      path: match.path || match.name,
      required: match.required,
      default: match.default,
      options: match.options,
      showWhen: match.showWhen
    })),
    totalMatches: matches.length,
    searchedIn: allProperties.length + ' properties'
  };
}

/**
 * Get node as tool info
 */
export async function getNodeAsToolInfo(
  nodeType: string,
  deps: NodeHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;

  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
  let node = repository.getNode(normalizedType);
  
  if (!node && normalizedType !== nodeType) {
    node = repository.getNode(nodeType);
  }
  
  if (!node) {
    const alternatives = getNodeTypeAlternatives(normalizedType);
    
    for (const alt of alternatives) {
      const found = repository.getNode(alt);
      if (found) {
        node = found;
        break;
      }
    }
  }
  
  if (!node) {
    throw new Error(`Node ${nodeType} not found`);
  }
  
  const commonUseCases = getCommonAIToolUseCases(node.nodeType);
  
  const aiToolCapabilities = {
    canBeUsedAsTool: true,
    hasUsableAsToolProperty: node.isAITool,
    requiresEnvironmentVariable: !node.isAITool && node.package !== 'n8n-nodes-base',
    connectionType: 'ai_tool',
    commonUseCases,
    requirements: {
      connection: 'Connect to the "ai_tool" port of an AI Agent node',
      environment: node.package !== 'n8n-nodes-base' ? 
        'Set N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true for community nodes' : 
        'No special environment variables needed for built-in nodes'
    },
    examples: getAIToolExamples(node.nodeType),
    tips: [
      'Give the tool a clear, descriptive name in the AI Agent settings',
      'Write a detailed tool description to help the AI understand when to use it',
      'Test the node independently before connecting it as a tool',
      node.isAITool ? 
        'This node is optimized for AI tool usage' : 
        'This is a regular node that can be used as an AI tool'
    ]
  };
  
  return {
    nodeType: node.nodeType,
    workflowNodeType: getWorkflowNodeType(node.package, node.nodeType),
    displayName: node.displayName,
    description: node.description,
    package: node.package,
    isMarkedAsAITool: node.isAITool,
    aiToolCapabilities
  };
}

/**
 * Validate node minimal
 */
export async function validateNodeMinimal(
  nodeType: string,
  config: Record<string, unknown>,
  deps: NodeHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;

  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
  let node = repository.getNode(normalizedType);
  
  if (!node && normalizedType !== nodeType) {
    node = repository.getNode(nodeType);
  }
  
  if (!node) {
    const alternatives = getNodeTypeAlternatives(normalizedType);
    
    for (const alt of alternatives) {
      const found = repository.getNode(alt);
      if (found) {
        node = found;
        break;
      }
    }
  }
  
  if (!node) {
    throw new Error(`Node ${nodeType} not found`);
  }
  
  const properties = node.properties || [];

  const configWithVersion = {
    '@version': node.version || 1,
    ...(config || {})
  };

  const missingFields: string[] = [];

  for (const prop of properties) {
    if (!prop.required) continue;

    if (prop.displayOptions && !ConfigValidator.isPropertyVisible(prop, configWithVersion)) {
      continue;
    }

    if (!config || !(prop.name in config)) {
      missingFields.push(prop.displayName || prop.name);
    }
  }
  
  return {
    nodeType: node.nodeType,
    displayName: node.displayName,
    valid: missingFields.length === 0,
    missingRequiredFields: missingFields
  };
}

/**
 * Validate node config
 */
export async function validateNodeConfig(
  nodeType: string,
  config: Record<string, unknown>,
  mode: ValidationMode,
  profile: ValidationProfile,
  deps: NodeHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;

  const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
  let node = repository.getNode(normalizedType);

  if (!node && normalizedType !== nodeType) {
    node = repository.getNode(nodeType);
  }

  if (!node) {
    const alternatives = getNodeTypeAlternatives(normalizedType);
    
    for (const alt of alternatives) {
      const found = repository.getNode(alt);
      if (found) {
        node = found;
        break;
      }
    }
  }
  
  if (!node) {
    throw new Error(`Node ${nodeType} not found`);
  }
  
  const properties = node.properties || [];

  const configWithVersion = {
    '@version': node.version || 1,
    ...config
  };

  const validationResult = EnhancedConfigValidator.validateWithMode(
    node.nodeType,
    configWithVersion,
    properties,
    mode,
    profile
  );
  
  return {
    nodeType: node.nodeType,
    workflowNodeType: getWorkflowNodeType(node.package, node.nodeType),
    displayName: node.displayName,
    ...validationResult,
    summary: {
      hasErrors: !validationResult.valid,
      errorCount: validationResult.errors.length,
      warningCount: validationResult.warnings.length,
      suggestionCount: validationResult.suggestions.length
    }
  };
}

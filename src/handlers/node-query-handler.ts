import { logger } from '../../utils/logger';
import { ToolArguments, GenericObject, NodeOperation } from '../../types/common-types';
import { NodeTypeNormalizer } from '../../utils/node-type-normalizer';
import { getNodeTypeAlternatives, getWorkflowNodeType } from '../../utils/node-utils';
import { DatabaseAdapter } from '../../database/database-adapter';
import { NodeRepository } from '../../database/node-repository';
import { ParsedNodeRow } from '../../types/database-types';
import { NodeRow, ToolVariantGuidance } from '../mcp/handlers/types';

export class NodeQueryHandler {
  constructor(
    private db: DatabaseAdapter,
    private repository: NodeRepository
  ) {}

  async listNodes(filters: ToolArguments = {}): Promise<GenericObject> {
    let query = 'SELECT * FROM nodes WHERE 1=1';
    const params: unknown[] = [];
    
    if (filters.package) {
      // Handle both formats
      const packageVariants = [
        filters.package,
        `@n8n/${filters.package}`,
        filters.package.replace('@n8n/', '')
      ];
      query += ' AND package_name IN (' + packageVariants.map(() => '?').join(',') + ')';
      params.push(...packageVariants);
    }

    if (filters.category) {
      query += ' AND category = ?';
      params.push(filters.category);
    }

    if (filters.developmentStyle) {
      query += ' AND development_style = ?';
      params.push(filters.developmentStyle);
    }

    if (filters.isAITool !== undefined) {
      query += ' AND is_ai_tool = ?';
      params.push(filters.isAITool ? 1 : 0);
    }

    query += ' ORDER BY display_name';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const nodes = this.db.prepare(query).all(...params) as NodeRow[];
    
    return {
      nodes: nodes.map(node => ({
        nodeType: node.node_type,
        displayName: node.display_name,
        description: node.description,
        category: node.category,
        package: node.package_name,
        developmentStyle: node.development_style,
        isAITool: Number(node.is_ai_tool) === 1,
        isTrigger: Number(node.is_trigger) === 1,
        isVersioned: Number(node.is_versioned) === 1,
      })),
      totalCount: nodes.length,
    };
  }

  async getNodeInfo(nodeType: string): Promise<GenericObject> {
    // First try with normalized type (repository will also normalize internally)
    const normalizedType = NodeTypeNormalizer.normalizeToFullForm(nodeType);
    let node = this.repository.getNode(normalizedType);
    
    if (!node && normalizedType !== nodeType) {
      // Try original if normalization changed it
      node = this.repository.getNode(nodeType);
    }
    
    if (!node) {
      // Fallback to other alternatives for edge cases
      const alternatives = getNodeTypeAlternatives(normalizedType);
      
      for (const alt of alternatives) {
        const found = this.repository.getNode(alt);
        if (found) {
          node = found;
          break;
        }
      }
    }
    
    if (!node) {
      throw new Error(`Node ${nodeType} not found`);
    }
    
    // Add AI tool capabilities information with null safety
    const aiToolCapabilities = {
      canBeUsedAsTool: true, // Any node can be used as a tool in n8n
      hasUsableAsToolProperty: node.isAITool ?? false,
      requiresEnvironmentVariable: !(node.isAITool ?? false) && node.package !== 'n8n-nodes-base',
      toolConnectionType: 'ai_tool',
      commonToolUseCases: this.getCommonAIToolUseCases(node.nodeType),
      environmentRequirement: node.package && node.package !== 'n8n-nodes-base' ?
        'N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true' :
        null
    };

    return {
      nodeType: node.nodeType,
      displayName: node.displayName,
      description: node.description,
      category: node.category,
      package: node.package,
      group: node.group,
      version: node.version,
      descriptionExtended: node.descriptionExtended,
      documentation: node.documentation,
      properties: node.properties,
      operations: node.operations,
      credentials: node.credentials,
      aiToolCapabilities,
      webhookOperations: this.getWebhookOperations(node),
      isAITool: node.isAITool,
      isTrigger: node.isTrigger,
      isWebhook: node.isWebhook,
      isVersioned: node.isVersioned,
      hasToolVariant: node.hasToolVariant,
      toolVariantOf: node.toolVariantOf,
      toolVariantNodeType: node.toolVariantNodeType,
      toolVariantGuidance: this.getToolVariantGuidance(node),
      examples: node.examples
    };
  }

  private getCommonAIToolUseCases(nodeType: string): string[] {
    const useCases: Record<string, string[]> = {
      'n8n-nodes-base.httpRequest': [
        'Making API calls to external services',
        'Fetching data from REST APIs',
        'Sending data to webhooks',
        'Integrating with SaaS platforms'
      ],
      'n8n-nodes-base.webhook': [
        'Receiving data from external systems',
        'Triggering workflows from webhooks',
        'Processing real-time events',
        'Integrating with external notifications'
      ],
      'n8n-nodes-base.set': [
        'Setting workflow variables',
        'Transforming data between steps',
        'Conditional data processing',
        'Preparing data for API calls'
      ],
      'n8n-nodes-base.code': [
        'Custom data transformations',
        'Complex business logic implementation',
        'Data validation and cleaning',
        'Integration with external libraries'
      ]
    };

    return useCases[nodeType] || [
      'Data processing and transformation',
      'Integration with other services',
      'Automation of business processes',
      'Custom workflow operations'
    ];
  }

  private getWebhookOperations(node: ParsedNodeRow): NodeOperation[] {
    if (!node.isWebhook) return [];

    return (node.operations as NodeOperation[] | undefined)?.filter((op: NodeOperation) =>
      op.type === 'webhook' || op.type === 'trigger'
    ) || [];
  }

  private getToolVariantGuidance(node: ParsedNodeRow): ToolVariantGuidance | { isToolVariant: boolean; hasToolVariant: boolean } {
    if (!node.hasToolVariant && !node.toolVariantOf) {
      return {
        isToolVariant: false,
        hasToolVariant: false
      };
    }

    return {
      isToolVariant: !!node.toolVariantOf,
      hasToolVariant: !!node.hasToolVariant,
      toolVariantOf: node.toolVariantOf,
      toolVariantNodeType: node.toolVariantNodeType,
      guidance: node.toolVariantOf ? 
        `This is a specialized variant of ${node.toolVariantOf}. Use the base ${node.toolVariantOf} node for general use cases.` :
        node.hasToolVariant ?
          `This node has specialized variants available for specific use cases.` :
          undefined
    };
  }

  calculateRelevance(node: NodeRow | ParsedNodeRow | Record<string, unknown>, query: string): number {
    if (!query) return 1.0;
    
    const queryLower = query.toLowerCase();
    const nameLower = (node.displayName || '').toLowerCase();
    const typeLower = (node.node_type || '').toLowerCase();
    const descLower = (node.description || '').toLowerCase();
    
    let score = 0.0;
    
    // Exact name match gets highest score
    if (nameLower === queryLower) score += 10.0;
    
    // Name starts with query
    if (nameLower.startsWith(queryLower)) score += 5.0;
    
    // Name contains query
    if (nameLower.includes(queryLower)) score += 3.0;
    
    // Node type matches
    if (typeLower.includes(queryLower)) score += 2.0;
    
    // Description contains query
    if (descLower.includes(queryLower)) score += 1.0;
    
    return Math.min(score / 10.0, 1.0); // Normalize to 0-1
  }

  calculateRelevanceScore(node: NodeRow | ParsedNodeRow | Record<string, unknown>, query: string): number {
    return this.calculateRelevance(node, query);
  }
}
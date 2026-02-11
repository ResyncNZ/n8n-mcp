import { DatabaseAdapter } from '../../database/database-adapter';
import { NodeRepository } from '../../database/node-repository';
import { logger } from '../../utils/logger';
import { NodeRow } from './types';
import { getWorkflowNodeType } from '../../utils/node-utils';

/**
 * Get database statistics
 */
export async function getDatabaseStatistics(
  db: DatabaseAdapter
): Promise<Record<string, unknown>> {
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(is_ai_tool) as ai_tools,
      SUM(is_trigger) as triggers,
      SUM(is_versioned) as versioned,
      SUM(CASE WHEN documentation IS NOT NULL THEN 1 ELSE 0 END) as with_docs,
      COUNT(DISTINCT package_name) as packages,
      COUNT(DISTINCT category) as categories
    FROM nodes
  `).get() as Record<string, number>;
  
  const packages = db.prepare(`
    SELECT package_name, COUNT(*) as count 
    FROM nodes 
    GROUP BY package_name
  `).all() as Array<{ package_name: string; count: number }>;
  
  const templateStats = db.prepare(`
    SELECT 
      COUNT(*) as total_templates,
      AVG(views) as avg_views,
      MIN(views) as min_views,
      MAX(views) as max_views
    FROM templates
  `).get() as Record<string, number>;
  
  return {
    totalNodes: stats.total,
    totalTemplates: templateStats.total_templates || 0,
    statistics: {
      aiTools: stats.ai_tools,
      triggers: stats.triggers,
      versionedNodes: stats.versioned,
      nodesWithDocumentation: stats.with_docs,
      documentationCoverage: Math.round((stats.with_docs / stats.total) * 100) + '%',
      uniquePackages: stats.packages,
      uniqueCategories: stats.categories,
      templates: {
        total: templateStats.total_templates || 0,
        avgViews: Math.round(templateStats.avg_views || 0),
        minViews: templateStats.min_views || 0,
        maxViews: templateStats.max_views || 0
      }
    },
    packageBreakdown: packages.map(pkg => ({
      package: pkg.package_name,
      nodeCount: pkg.count,
    })),
  };
}

/**
 * List AI tools from the database
 */
export async function listAITools(
  db: DatabaseAdapter,
  repository: NodeRepository
): Promise<Record<string, unknown>> {
  const tools = repository.getAITools();
  
  const aiCount = db.prepare('SELECT COUNT(*) as ai_count FROM nodes WHERE is_ai_tool = 1').get() as { ai_count: number };
  
  return {
    tools,
    totalCount: tools.length,
    requirements: {
      environmentVariable: 'N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true',
      nodeProperty: 'usableAsTool: true',
    },
    usage: {
      description: 'These nodes have the usableAsTool property set to true, making them optimized for AI agent usage.',
      note: 'ANY node in n8n can be used as an AI tool by connecting it to the ai_tool port of an AI Agent node.',
      examples: [
        'Regular nodes like Slack, Google Sheets, or HTTP Request can be used as tools',
        'Connect any node to an AI Agent\'s tool port to make it available for AI-driven automation',
        'Community nodes require the environment variable to be set'
      ]
    }
  };
}

/**
 * List nodes with optional filters
 */
export async function listNodes(
  db: DatabaseAdapter,
  filters: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  let query = 'SELECT * FROM nodes WHERE 1=1';
  const params: unknown[] = [];
  
  if (filters.package) {
    const packageName = String(filters.package);
    const packageVariants = [
      packageName,
      `@n8n/${packageName}`,
      packageName.replace('@n8n/', '')
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

  const nodes = db.prepare(query).all(...params) as NodeRow[];
  
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

/**
 * Safe JSON parse with default value
 */
export function safeJsonParse(json: string, defaultValue: unknown = null): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return defaultValue;
  }
}

/**
 * Get output descriptions for a node type
 */
export function getOutputDescriptions(
  nodeType: string,
  outputName: string,
  index: number
): { description: string; connectionGuidance: string } {
  if (nodeType === 'nodes-base.splitInBatches') {
    if (outputName === 'done' && index === 0) {
      return {
        description: 'Final processed data after all iterations complete',
        connectionGuidance: 'Connect to nodes that should run AFTER the loop completes'
      };
    } else if (outputName === 'loop' && index === 1) {
      return {
        description: 'Current batch data for this iteration',
        connectionGuidance: 'Connect to nodes that process items INSIDE the loop (and connect their output back to this node)'
      };
    }
  }
  
  if (nodeType === 'nodes-base.if') {
    if (outputName === 'true' && index === 0) {
      return {
        description: 'Items that match the condition',
        connectionGuidance: 'Connect to nodes that handle the TRUE case'
      };
    } else if (outputName === 'false' && index === 1) {
      return {
        description: 'Items that do not match the condition',
        connectionGuidance: 'Connect to nodes that handle the FALSE case'
      };
    }
  }
  
  if (nodeType === 'nodes-base.switch') {
    return {
      description: `Output ${index}: ${outputName || 'Route ' + index}`,
      connectionGuidance: `Connect to nodes for the "${outputName || 'route ' + index}" case`
    };
  }
  
  return {
    description: outputName || `Output ${index}`,
    connectionGuidance: 'Connect to downstream nodes'
  };
}

/**
 * Get common AI tool use cases for a node type
 */
export function getCommonAIToolUseCases(nodeType: string): string[] {
  const useCaseMap: Record<string, string[]> = {
    'nodes-base.slack': [
      'Send notifications about task completion',
      'Post updates to channels',
      'Send direct messages',
      'Create alerts and reminders'
    ],
    'nodes-base.googleSheets': [
      'Read data for analysis',
      'Log results and outputs',
      'Update spreadsheet records',
      'Create reports'
    ],
    'nodes-base.gmail': [
      'Send email notifications',
      'Read and process emails',
      'Send reports and summaries',
      'Handle email-based workflows'
    ],
    'nodes-base.httpRequest': [
      'Call external APIs',
      'Fetch data from web services',
      'Send webhooks',
      'Integrate with any REST API'
    ],
    'nodes-base.postgres': [
      'Query database for information',
      'Store analysis results',
      'Update records based on AI decisions',
      'Generate reports from data'
    ],
    'nodes-base.webhook': [
      'Receive external triggers',
      'Create callback endpoints',
      'Handle incoming data',
      'Integrate with external systems'
    ]
  };
  
  for (const [key, useCases] of Object.entries(useCaseMap)) {
    if (nodeType.includes(key)) {
      return useCases;
    }
  }
  
  return [
    'Perform automated actions',
    'Integrate with external services',
    'Process and transform data',
    'Extend AI agent capabilities'
  ];
}

/**
 * Build tool variant guidance for node responses
 */
export function buildToolVariantGuidance(node: Record<string, unknown>): 
  | { isToolVariant: boolean; toolVariantOf?: string; hasToolVariant: boolean; toolVariantNodeType?: string; guidance?: string }
  | undefined {
  const isToolVariant = !!node.isToolVariant;
  const hasToolVariant = !!node.hasToolVariant;
  const toolVariantOf = node.toolVariantOf as string | undefined;

  if (!isToolVariant && !hasToolVariant) {
    return undefined;
  }

  if (isToolVariant) {
    return {
      isToolVariant: true,
      toolVariantOf,
      hasToolVariant: false,
      guidance: `This is the Tool variant for AI Agent integration. Use this node type when connecting to AI Agents. The base node is: ${toolVariantOf}`
    };
  }

  if (hasToolVariant && node.nodeType) {
    const toolVariantNodeType = `${node.nodeType}Tool`;
    return {
      isToolVariant: false,
      hasToolVariant: true,
      toolVariantNodeType,
      guidance: `To use this node with AI Agents, use the Tool variant: ${toolVariantNodeType}. The Tool variant has an additional 'toolDescription' property and outputs 'ai_tool' instead of 'main'.`
    };
  }

  return undefined;
}

/**
 * Get AI tool examples for a node type
 */
export function getAIToolExamples(nodeType: string): Record<string, unknown> {
  const exampleMap: Record<string, Record<string, unknown>> = {
    'nodes-base.slack': {
      toolName: 'Send Slack Message',
      toolDescription: 'Sends a message to a specified Slack channel or user. Use this to notify team members about important events or results.',
      nodeConfig: {
        resource: 'message',
        operation: 'post',
        channel: '={{ $fromAI("channel", "The Slack channel to send to, e.g. #general") }}',
        text: '={{ $fromAI("message", "The message content to send") }}'
      }
    },
    'nodes-base.googleSheets': {
      toolName: 'Update Google Sheet',
      toolDescription: 'Reads or updates data in a Google Sheets spreadsheet. Use this to log information, retrieve data, or update records.',
      nodeConfig: {
        operation: 'append',
        sheetId: 'your-sheet-id',
        range: 'A:Z',
        dataMode: 'autoMap'
      }
    },
    'nodes-base.httpRequest': {
      toolName: 'Call API',
      toolDescription: 'Makes HTTP requests to external APIs. Use this to fetch data, trigger webhooks, or integrate with any web service.',
      nodeConfig: {
        method: '={{ $fromAI("method", "HTTP method: GET, POST, PUT, DELETE") }}',
        url: '={{ $fromAI("url", "The complete API endpoint URL") }}',
        sendBody: true,
        bodyContentType: 'json',
        jsonBody: '={{ $fromAI("body", "Request body as JSON object") }}'
      }
    }
  };
  
  for (const [key, example] of Object.entries(exampleMap)) {
    if (nodeType.includes(key)) {
      return example;
    }
  }
  
  return {
    toolName: 'Custom Tool',
    toolDescription: 'Performs specific operations. Describe what this tool does and when to use it.',
    nodeConfig: {
      note: 'Configure the node based on its specific requirements'
    }
  };
}

/**
 * Get property value from config by path
 */
export function getPropertyValue(config: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let value: unknown = config;
  
  for (const part of parts) {
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const arr = (value as Record<string, unknown>)?.[arrayMatch[1]] as unknown[] | undefined;
      value = arr?.[parseInt(arrayMatch[2])];
    } else {
      value = (value as Record<string, unknown>)?.[part];
    }
  }
  
  return value;
}

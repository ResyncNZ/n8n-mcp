import { logger } from '../../utils/logger';
import { ToolArguments, GenericObject, NodeProperty } from '../../types/common-types';
import { NodeTypeNormalizer } from '../../utils/node-type-normalizer';
import { getNodeTypeAlternatives, getWorkflowNodeType } from '../../utils/node-utils';
import { PropertyFilter } from '../../services/property-filter';
import { DatabaseAdapter } from '../../database/database-adapter';
import { NodeRepository } from '../../database/node-repository';
import { NodeRow } from '../mcp/handlers/types';

type SearchNodeRow = NodeRow & {
  rank: number;
  is_community?: number;
  is_verified?: number;
  author_name?: string;
  npm_downloads?: number;
  relevanceScore?: number;
};

export class NodeSearchHandler {
  constructor(
    private db: DatabaseAdapter,
    private repository: NodeRepository
  ) {}

  async searchNodes(
    query: string, 
    limit: number = 20, 
    options?: {
      mode?: string;
      includeExamples?: boolean;
      source?: string;
    }
  ): Promise<GenericObject> {
    if (!query?.trim()) {
      throw new Error('Search query is required');
    }

    const mode = options?.mode || 'OR';
    const cleanedQuery = query.trim().replace(/[<>]/g, '');
    
    // Try FTS5 search first (if available)
    try {
      return await this.searchNodesFTS(cleanedQuery, limit, mode, options);
    } catch (ftsError) {
      logger.warn('FTS5 search failed, falling back to LIKE search:', ftsError);
      return await this.searchNodesLIKE(query, limit);
    }
  }

  private async searchNodesFTS(
    ftsQuery: string, 
    limit: number, 
    mode: string = 'OR',
    options?: {
      includeExamples?: boolean;
      source?: string;
    }
  ): Promise<GenericObject> {
    // Build FTS query based on mode
    let query = '';
    switch (mode) {
      case 'AND':
        query = ftsQuery.split(/\s+/).map(term => `${term}*`).join(' AND ');
        break;
      case 'OR':
      default:
        query = ftsQuery.split(/\s+/).map(term => `${term}*`).join(' OR ');
        break;
    }

    // Add source filtering if specified
    let sourceFilter = '';
    switch (options?.source) {
      case 'core':
        sourceFilter = 'AND n.is_community = 0';
        break;
      case 'community':
        sourceFilter = 'AND n.is_community = 1';
        break;
      case 'verified':
        sourceFilter = 'AND n.is_community = 1 AND n.is_verified = 1';
        break;
      // 'all' - no filter
    }

    // Use FTS5 with ranking
    const nodes = this.db.prepare(`
      SELECT
        n.*,
        rank
      FROM nodes n
      JOIN nodes_fts ON n.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
      ${sourceFilter}
      ORDER BY
        CASE
          WHEN LOWER(n.display_name) = LOWER(?) THEN 0
          WHEN LOWER(n.display_name) LIKE LOWER(?) THEN 1
          WHEN LOWER(n.node_type) LIKE LOWER(?) THEN 2
          ELSE 3
        END,
        rank,
        n.display_name
      LIMIT ?
    `).all(query, ftsQuery, `%${ftsQuery}%`, `%${ftsQuery}%`, limit) as SearchNodeRow[];
    
    // Apply additional relevance scoring for better results
    const scoredNodes = nodes.map(node => ({
      ...node,
      relevanceScore: this.calculateRelevanceScore(node, ftsQuery)
    }));
    
    // Sort by combined score (FTS rank + relevance score)
    scoredNodes.sort((a, b) => {
      // Prioritize exact matches
      if (a.display_name.toLowerCase() === ftsQuery.toLowerCase()) return -1;
      if (b.display_name.toLowerCase() === ftsQuery.toLowerCase()) return 1;
      
      // Then by relevance score
      if (a.relevanceScore !== b.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      
      // Then by FTS rank
      return a.rank - b.rank;
    });
    
    // If FTS didn't find key primary nodes, augment with LIKE search
    const hasHttpRequest = scoredNodes.some(n => n.node_type === 'nodes-base.httpRequest');
    if (ftsQuery.toLowerCase().includes('http') && !hasHttpRequest) {
      // FTS missed HTTP Request, fall back to LIKE search
      logger.debug('FTS missed HTTP Request node, augmenting with LIKE search');
      return this.searchNodesLIKE(query, limit);
    }
    
    const result: GenericObject = {
      query,
      results: scoredNodes.map(node => {
        const nodeResult: GenericObject = {
          nodeType: node.node_type,
          workflowNodeType: getWorkflowNodeType(node.package_name, node.node_type),
          displayName: node.display_name,
          description: node.description,
          category: node.category,
          package: node.package_name,
          relevance: this.calculateRelevance(node, ftsQuery)
        };

        // Add community metadata if this is a community node
        if (node.is_community === 1) {
          nodeResult.isCommunity = true;
          nodeResult.isVerified = node.is_verified === 1;
          if (node.author_name) {
            nodeResult.authorName = node.author_name;
          }
          if (node.npm_downloads) {
            nodeResult.npmDownloads = node.npm_downloads;
          }
        }

        return nodeResult;
      }),
      totalCount: scoredNodes.length
    };

    // Only include mode if it's not the default
    if (mode !== 'OR') {
      result.mode = mode;
    }

    return result;
  }

  private async searchNodesLIKE(query: string, limit: number): Promise<GenericObject> {
    const cleanedQuery = query.trim().replace(/[<>]/g, '');
    
    // Use LIKE queries with ranking
    const nodes = this.db.prepare(`
      SELECT * FROM nodes 
      WHERE (
        LOWER(display_name) LIKE LOWER(?) OR
        LOWER(node_type) LIKE LOWER(?) OR
        LOWER(description) LIKE LOWER(?)
      )
      ORDER BY
        CASE
          WHEN LOWER(display_name) = LOWER(?) THEN 0
          WHEN LOWER(display_name) LIKE LOWER(?) THEN 1
          WHEN LOWER(node_type) LIKE LOWER(?) THEN 2
          ELSE 3
        END,
        display_name
      LIMIT ?
    `).all(
      `%${cleanedQuery}%`, 
      `%${cleanedQuery}%`, 
      `%${cleanedQuery}%`,
      cleanedQuery,
      `%${cleanedQuery}%`,
      `%${cleanedQuery}%`,
      limit
    ) as SearchNodeRow[];
    
    // Apply relevance scoring
    const scoredNodes = nodes.map(node => ({
      ...node,
      relevanceScore: this.calculateRelevanceScore(node, cleanedQuery)
    }));
    
    // Sort by relevance score
    scoredNodes.sort((a, b) => {
      // Prioritize exact name matches
      if (a.display_name.toLowerCase() === cleanedQuery.toLowerCase()) return -1;
      if (b.display_name.toLowerCase() === cleanedQuery.toLowerCase()) return 1;
      
      // Then by relevance score
      return b.relevanceScore - a.relevanceScore;
    });

    return {
      query,
      results: scoredNodes.map(node => ({
        nodeType: node.node_type,
        workflowNodeType: getWorkflowNodeType(node.package_name, node.node_type),
        displayName: node.display_name,
        description: node.description,
        category: node.category,
        package: node.package_name,
        relevance: this.calculateRelevance(node, cleanedQuery)
      })),
      totalCount: scoredNodes.length,
      fallback: true // Indicate this was a fallback search
    };
  }

  async searchNodeProperties(nodeType: string, query: string, maxResults: number = 20): Promise<GenericObject> {
    // Get the node
    // First try with normalized type
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
    
    // Get properties and search (already parsed by repository)
    const allProperties = node.properties || [];
    const matches = PropertyFilter.searchProperties(allProperties, query, maxResults);
    
    return {
      nodeType: node.nodeType,
      query,
      matches: matches.map((match: NodeProperty) => ({
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

  private calculateRelevance(node: SearchNodeRow | Record<string, unknown>, query: string): number {
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

  private calculateRelevanceScore(node: SearchNodeRow | Record<string, unknown>, query: string): number {
    return this.calculateRelevance(node, query);
  }
}
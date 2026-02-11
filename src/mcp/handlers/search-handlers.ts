import { DatabaseAdapter } from '../../database/database-adapter';
import { logger } from '../../utils/logger';
import { getWorkflowNodeType } from '../../utils/node-utils';
import { telemetry } from '../../telemetry';
import { NodeRow, SearchOptions } from './types';

export interface SearchHandlerDeps {
  db: DatabaseAdapter;
}

/**
 * Primary search method used by ALL MCP search tools
 */
export async function searchNodes(
  query: string,
  limit: number,
  options: SearchOptions | undefined,
  deps: SearchHandlerDeps
): Promise<Record<string, unknown>> {
  const { db } = deps;

  let normalizedQuery = query;
  
  if (query.includes('n8n-nodes-base.') || query.includes('@n8n/n8n-nodes-langchain.')) {
    normalizedQuery = query
      .replace(/n8n-nodes-base\./g, 'nodes-base.')
      .replace(/@n8n\/n8n-nodes-langchain\./g, 'nodes-langchain.');
  }
  
  const searchMode = options?.mode || 'OR';
  
  const ftsExists = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='nodes_fts'
  `).get();
  
  if (ftsExists) {
    logger.debug(`Using FTS5 search with includeExamples=${options?.includeExamples}`);
    return searchNodesFTS(normalizedQuery, limit, searchMode, options, deps);
  } else {
    logger.debug('Using LIKE search (no FTS5)');
    return searchNodesLIKE(normalizedQuery, limit, options, deps);
  }
}

/**
 * FTS5 search implementation
 */
async function searchNodesFTS(
  query: string,
  limit: number,
  mode: 'OR' | 'AND' | 'FUZZY',
  options: SearchOptions | undefined,
  deps: SearchHandlerDeps
): Promise<Record<string, unknown>> {
  const { db } = deps;

  const cleanedQuery = query.trim();
  if (!cleanedQuery) {
    return { query, results: [], totalCount: 0 };
  }
  
  if (mode === 'FUZZY') {
    return searchNodesFuzzy(cleanedQuery, limit, deps);
  }
  
  let ftsQuery: string;
  
  if (cleanedQuery.startsWith('"') && cleanedQuery.endsWith('"')) {
    ftsQuery = cleanedQuery;
  } else {
    const words = cleanedQuery.split(/\s+/).filter(w => w.length > 0);
    
    switch (mode) {
      case 'AND':
        ftsQuery = words.join(' AND ');
        break;
      case 'OR':
      default:
        ftsQuery = words.join(' OR ');
        break;
    }
  }
  
  try {
    let sourceFilter = '';
    const sourceValue = options?.source || 'all';
    switch (sourceValue) {
      case 'core':
        sourceFilter = 'AND n.is_community = 0';
        break;
      case 'community':
        sourceFilter = 'AND n.is_community = 1';
        break;
      case 'verified':
        sourceFilter = 'AND n.is_community = 1 AND n.is_verified = 1';
        break;
    }

    const nodes = db.prepare(`
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
    `).all(ftsQuery, cleanedQuery, `%${cleanedQuery}%`, `%${cleanedQuery}%`, limit) as (NodeRow & { rank: number })[];
    
    const scoredNodes = nodes.map(node => {
      const relevanceScore = calculateRelevanceScore(node, cleanedQuery);
      return { ...node, relevanceScore };
    });
    
    scoredNodes.sort((a, b) => {
      if (a.display_name.toLowerCase() === cleanedQuery.toLowerCase()) return -1;
      if (b.display_name.toLowerCase() === cleanedQuery.toLowerCase()) return 1;
      
      if (a.relevanceScore !== b.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      
      return a.rank - b.rank;
    });
    
    const hasHttpRequest = scoredNodes.some(n => n.node_type === 'nodes-base.httpRequest');
    if (cleanedQuery.toLowerCase().includes('http') && !hasHttpRequest) {
      logger.debug('FTS missed HTTP Request node, augmenting with LIKE search');
      return searchNodesLIKE(query, limit, options, deps);
    }
    
    const result: Record<string, unknown> = {
      query,
      results: scoredNodes.map(node => {
        const nodeResult: Record<string, unknown> = {
          nodeType: node.node_type,
          workflowNodeType: getWorkflowNodeType(node.package_name, node.node_type),
          displayName: node.display_name,
          description: node.description,
          category: node.category,
          package: node.package_name,
          relevance: calculateRelevance(node, cleanedQuery)
        };

        if ((node as Record<string, unknown>).is_community === 1) {
          nodeResult.isCommunity = true;
          nodeResult.isVerified = (node as Record<string, unknown>).is_verified === 1;
          if ((node as Record<string, unknown>).author_name) {
            nodeResult.authorName = (node as Record<string, unknown>).author_name;
          }
          if ((node as Record<string, unknown>).npm_downloads) {
            nodeResult.npmDownloads = (node as Record<string, unknown>).npm_downloads;
          }
        }

        return nodeResult;
      }),
      totalCount: scoredNodes.length
    };

    if (mode !== 'OR') {
      result.mode = mode;
    }

    if (options?.includeExamples) {
      try {
        for (const nodeResult of result.results as Array<Record<string, unknown>>) {
          const examples = db.prepare(`
            SELECT
              parameters_json,
              template_name,
              template_views
            FROM template_node_configs
            WHERE node_type = ?
            ORDER BY rank
            LIMIT 2
          `).all(nodeResult.workflowNodeType as string) as Array<{
            parameters_json: string;
            template_name: string;
            template_views: number;
          }>;

          if (examples.length > 0) {
            nodeResult.examples = examples.map((ex) => ({
              configuration: JSON.parse(ex.parameters_json),
              template: ex.template_name,
              views: ex.template_views
            }));
          }
        }
      } catch (error: unknown) {
        logger.error(`Failed to add examples:`, error);
      }
    }

    telemetry.trackSearchQuery(query, scoredNodes.length, mode ?? 'OR');

    return result;
    
  } catch (error: unknown) {
    logger.warn('FTS5 search failed, falling back to LIKE search:', (error as Error).message);
    
    if ((error as Error).message.includes('syntax error') || (error as Error).message.includes('fts5')) {
      logger.warn(`FTS5 syntax error for query "${query}" in mode ${mode}`);
      
      const likeResult = await searchNodesLIKE(query, limit, options, deps);

      telemetry.trackSearchQuery(query, (likeResult.results as unknown[])?.length ?? 0, `${mode}_LIKE_FALLBACK`);

      return {
        ...likeResult,
        mode
      };
    }
    
    return searchNodesLIKE(query, limit, options, deps);
  }
}

/**
 * Fuzzy search implementation
 */
async function searchNodesFuzzy(
  query: string,
  limit: number,
  deps: SearchHandlerDeps
): Promise<Record<string, unknown>> {
  const { db } = deps;
  
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  
  if (words.length === 0) {
    return { query, results: [], totalCount: 0, mode: 'FUZZY' };
  }
  
  const candidateNodes = db.prepare(`
    SELECT * FROM nodes
  `).all() as NodeRow[];
  
  const scoredNodes = candidateNodes.map(node => {
    const score = calculateFuzzyScore(node, query);
    return { node, score };
  });
  
  const matchingNodes = scoredNodes
    .filter(item => item.score >= 200)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.node);
  
  if (matchingNodes.length === 0) {
    const topScores = scoredNodes
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    logger.debug(`FUZZY search for "${query}" - no matches above 400. Top scores:`, 
      topScores.map(s => ({ name: s.node.display_name, score: s.score })));
  }
  
  return {
    query,
    mode: 'FUZZY',
    results: matchingNodes.map(node => ({
      nodeType: node.node_type,
      workflowNodeType: getWorkflowNodeType(node.package_name, node.node_type),
      displayName: node.display_name,
      description: node.description,
      category: node.category,
      package: node.package_name
    })),
    totalCount: matchingNodes.length
  };
}

/**
 * LIKE search implementation
 */
async function searchNodesLIKE(
  query: string,
  limit: number,
  options: SearchOptions | undefined,
  deps: SearchHandlerDeps
): Promise<Record<string, unknown>> {
  const { db } = deps;

  let sourceFilter = '';
  const sourceValue = options?.source || 'all';
  switch (sourceValue) {
    case 'core':
      sourceFilter = 'AND is_community = 0';
      break;
    case 'community':
      sourceFilter = 'AND is_community = 1';
      break;
    case 'verified':
      sourceFilter = 'AND is_community = 1 AND is_verified = 1';
      break;
  }

  if (query.startsWith('"') && query.endsWith('"')) {
    const exactPhrase = query.slice(1, -1);
    const nodes = db.prepare(`
      SELECT * FROM nodes
      WHERE (node_type LIKE ? OR display_name LIKE ? OR description LIKE ?)
      ${sourceFilter}
      LIMIT ?
    `).all(`%${exactPhrase}%`, `%${exactPhrase}%`, `%${exactPhrase}%`, limit * 3) as NodeRow[];

    const rankedNodes = rankSearchResults(nodes, exactPhrase, limit);

    const result: Record<string, unknown> = {
      query,
      results: rankedNodes.map(node => {
        const nodeResult: Record<string, unknown> = {
          nodeType: node.node_type,
          workflowNodeType: getWorkflowNodeType(node.package_name, node.node_type),
          displayName: node.display_name,
          description: node.description,
          category: node.category,
          package: node.package_name
        };

        if ((node as Record<string, unknown>).is_community === 1) {
          nodeResult.isCommunity = true;
          nodeResult.isVerified = (node as Record<string, unknown>).is_verified === 1;
          if ((node as Record<string, unknown>).author_name) {
            nodeResult.authorName = (node as Record<string, unknown>).author_name;
          }
          if ((node as Record<string, unknown>).npm_downloads) {
            nodeResult.npmDownloads = (node as Record<string, unknown>).npm_downloads;
          }
        }

        return nodeResult;
      }),
      totalCount: rankedNodes.length
    };

    if (options?.includeExamples) {
      for (const nodeResult of result.results as Array<Record<string, unknown>>) {
        try {
          const examples = db.prepare(`
            SELECT
              parameters_json,
              template_name,
              template_views
            FROM template_node_configs
            WHERE node_type = ?
            ORDER BY rank
            LIMIT 2
          `).all(nodeResult.workflowNodeType as string) as Array<{
            parameters_json: string;
            template_name: string;
            template_views: number;
          }>;

          if (examples.length > 0) {
            nodeResult.examples = examples.map((ex) => ({
              configuration: JSON.parse(ex.parameters_json),
              template: ex.template_name,
              views: ex.template_views
            }));
          }
        } catch (error: unknown) {
          logger.warn(`Failed to fetch examples for ${nodeResult.nodeType}:`, (error as Error).message);
        }
      }
    }

    return result;
  }
  
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  
  if (words.length === 0) {
    return { query, results: [], totalCount: 0 };
  }
  
  const conditions = words.map(() =>
    '(node_type LIKE ? OR display_name LIKE ? OR description LIKE ?)'
  ).join(' OR ');

  const params: (string | number)[] = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`]);
  params.push(limit * 3);
  
  const nodes = db.prepare(`
    SELECT DISTINCT * FROM nodes
    WHERE (${conditions})
    ${sourceFilter}
    LIMIT ?
  `).all(...params) as NodeRow[];
  
  const rankedNodes = rankSearchResults(nodes, query, limit);

  const result: Record<string, unknown> = {
    query,
    results: rankedNodes.map(node => {
      const nodeResult: Record<string, unknown> = {
        nodeType: node.node_type,
        workflowNodeType: getWorkflowNodeType(node.package_name, node.node_type),
        displayName: node.display_name,
        description: node.description,
        category: node.category,
        package: node.package_name
      };

      if ((node as Record<string, unknown>).is_community === 1) {
        nodeResult.isCommunity = true;
        nodeResult.isVerified = (node as Record<string, unknown>).is_verified === 1;
        if ((node as Record<string, unknown>).author_name) {
          nodeResult.authorName = (node as Record<string, unknown>).author_name;
        }
        if ((node as Record<string, unknown>).npm_downloads) {
          nodeResult.npmDownloads = (node as Record<string, unknown>).npm_downloads;
        }
      }

      return nodeResult;
    }),
    totalCount: rankedNodes.length
  };

  if (options?.includeExamples) {
    for (const nodeResult of result.results as Array<Record<string, unknown>>) {
      try {
        const examples = db.prepare(`
          SELECT
            parameters_json,
            template_name,
            template_views
          FROM template_node_configs
          WHERE node_type = ?
          ORDER BY rank
          LIMIT 2
        `).all(nodeResult.workflowNodeType as string) as Array<{
          parameters_json: string;
          template_name: string;
          template_views: number;
        }>;

        if (examples.length > 0) {
          nodeResult.examples = examples.map((ex) => ({
            configuration: JSON.parse(ex.parameters_json),
            template: ex.template_name,
            views: ex.template_views
          }));
        }
      } catch (error: unknown) {
        logger.warn(`Failed to fetch examples for ${nodeResult.nodeType}:`, (error as Error).message);
      }
    }
  }

  return result;
}

/**
 * Calculate relevance string for a node
 */
function calculateRelevance(node: NodeRow, query: string): string {
  const lowerQuery = query.toLowerCase();
  if (node.node_type.toLowerCase().includes(lowerQuery)) return 'high';
  if (node.display_name.toLowerCase().includes(lowerQuery)) return 'high';
  if (node.description?.toLowerCase().includes(lowerQuery)) return 'medium';
  return 'low';
}

/**
 * Calculate relevance score for FTS ranking
 */
function calculateRelevanceScore(node: NodeRow, query: string): number {
  const query_lower = query.toLowerCase();
  const name_lower = node.display_name.toLowerCase();
  const type_lower = node.node_type.toLowerCase();
  const type_without_prefix = type_lower.replace(/^nodes-base\./, '').replace(/^nodes-langchain\./, '');
  
  let score = 0;
  
  if (name_lower === query_lower) {
    score = 1000;
  } else if (type_without_prefix === query_lower) {
    score = 950;
  } else if (query_lower === 'webhook' && node.node_type === 'nodes-base.webhook') {
    score = 900;
  } else if ((query_lower === 'http' || query_lower === 'http request' || query_lower === 'http call') && node.node_type === 'nodes-base.httpRequest') {
    score = 900;
  } else if (query_lower.includes('http') && query_lower.includes('call') && node.node_type === 'nodes-base.httpRequest') {
    score = 890;
  } else if (query_lower.includes('http') && node.node_type === 'nodes-base.httpRequest') {
    score = 850;
  } else if (query_lower.includes('webhook') && node.node_type === 'nodes-base.webhook') {
    score = 850;
  } else if (name_lower.startsWith(query_lower)) {
    score = 800;
  } else if (new RegExp(`\\b${query_lower}\\b`, 'i').test(node.display_name)) {
    score = 700;
  } else if (name_lower.includes(query_lower)) {
    score = 600;
  } else if (type_without_prefix.includes(query_lower)) {
    score = 500;
  } else if (node.description?.toLowerCase().includes(query_lower)) {
    score = 400;
  }
  
  return score;
}

/**
 * Calculate fuzzy score for typo-tolerant search
 */
function calculateFuzzyScore(node: NodeRow, query: string): number {
  const queryLower = query.toLowerCase();
  const displayNameLower = node.display_name.toLowerCase();
  const nodeTypeLower = node.node_type.toLowerCase();
  const nodeTypeClean = nodeTypeLower.replace(/^nodes-base\./, '').replace(/^nodes-langchain\./, '');
  
  if (displayNameLower === queryLower || nodeTypeClean === queryLower) {
    return 1000;
  }
  
  const nameDistance = getEditDistance(queryLower, displayNameLower);
  const typeDistance = getEditDistance(queryLower, nodeTypeClean);
  
  const nameWords = displayNameLower.split(/\s+/);
  let minWordDistance = Infinity;
  for (const word of nameWords) {
    const distance = getEditDistance(queryLower, word);
    if (distance < minWordDistance) {
      minWordDistance = distance;
    }
  }
  
  const bestDistance = Math.min(nameDistance, typeDistance, minWordDistance);
  
  let matchedLen = queryLower.length;
  if (minWordDistance === bestDistance) {
    for (const word of nameWords) {
      if (getEditDistance(queryLower, word) === minWordDistance) {
        matchedLen = Math.max(queryLower.length, word.length);
        break;
      }
    }
  } else if (typeDistance === bestDistance) {
    matchedLen = Math.max(queryLower.length, nodeTypeClean.length);
  } else {
    matchedLen = Math.max(queryLower.length, displayNameLower.length);
  }
  
  const similarity = 1 - (bestDistance / matchedLen);
  
  if (displayNameLower.includes(queryLower) || nodeTypeClean.includes(queryLower)) {
    return 800 + (similarity * 100);
  }
  
  if (displayNameLower.startsWith(queryLower) || 
      nodeTypeClean.startsWith(queryLower) ||
      nameWords.some(w => w.startsWith(queryLower))) {
    return 700 + (similarity * 100);
  }
  
  if (bestDistance <= 2) {
    return 500 + ((2 - bestDistance) * 100) + (similarity * 50);
  }
  
  if (bestDistance <= 3 && queryLower.length >= 4) {
    return 400 + ((3 - bestDistance) * 50) + (similarity * 50);
  }
  
  return similarity * 300;
}

/**
 * Levenshtein distance calculation
 */
function getEditDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  
  return dp[m][n];
}

/**
 * Rank search results by relevance
 */
function rankSearchResults(nodes: NodeRow[], query: string, limit: number): NodeRow[] {
  const query_lower = query.toLowerCase();
  
  const scoredNodes = nodes.map(node => {
    const name_lower = node.display_name.toLowerCase();
    const type_lower = node.node_type.toLowerCase();
    const type_without_prefix = type_lower.replace(/^nodes-base\./, '').replace(/^nodes-langchain\./, '');
    
    let score = 0;
    
    if (name_lower === query_lower) {
      score = 1000;
    } else if (type_without_prefix === query_lower) {
      score = 950;
    } else if (query_lower === 'webhook' && node.node_type === 'nodes-base.webhook') {
      score = 900;
    } else if ((query_lower === 'http' || query_lower === 'http request' || query_lower === 'http call') && node.node_type === 'nodes-base.httpRequest') {
      score = 900;
    } else if (query_lower.includes('webhook') && node.node_type === 'nodes-base.webhook') {
      score = 850;
    } else if (query_lower.includes('http') && node.node_type === 'nodes-base.httpRequest') {
      score = 850;
    } else if (name_lower.startsWith(query_lower)) {
      score = 800;
    } else if (new RegExp(`\\b${query_lower}\\b`, 'i').test(node.display_name)) {
      score = 700;
    } else if (name_lower.includes(query_lower)) {
      score = 600;
    } else if (type_without_prefix.includes(query_lower)) {
      score = 500;
    } else if (node.description?.toLowerCase().includes(query_lower)) {
      score = 400;
    }
    
    const words = query_lower.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) {
      const allWordsInName = words.every(word => name_lower.includes(word));
      const allWordsInDesc = words.every(word => node.description?.toLowerCase().includes(word));
      
      if (allWordsInName) score += 200;
      else if (allWordsInDesc) score += 100;
      
      if (query_lower === 'http call' && name_lower === 'http request') {
        score = 920;
      }
    }
    
    return { node, score };
  });
  
  scoredNodes.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.node.display_name.localeCompare(b.node.display_name);
  });
  
  return scoredNodes.slice(0, limit).map(item => item.node);
}

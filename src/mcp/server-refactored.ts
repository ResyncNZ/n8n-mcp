import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { n8nDocumentationToolsFinal } from './tools';
import { n8nManagementTools } from './tools-n8n-manager';
import { makeToolsN8nFriendly } from './tools-n8n-friendly';
import { logger } from '../utils/logger';
import { NodeRepository } from '../database/node-repository';
import { DatabaseAdapter, createDatabaseAdapter } from '../database/database-adapter';
import { getSharedDatabase, releaseSharedDatabase, SharedDatabaseState } from '../database/shared-database';
import { EnhancedConfigValidator, ValidationMode, ValidationProfile } from '../services/enhanced-config-validator';
import { SimpleCache } from '../utils/simple-cache';
import { TemplateService } from '../templates/template-service';
import { isN8nApiConfigured } from '../config/n8n-api';
import * as n8nHandlers from './handlers-n8n-manager';
import { handleUpdatePartialWorkflow } from './handlers-workflow-diff';
import { getToolDocumentation, getToolsOverview } from './tools-documentation';
import { PROJECT_VERSION } from '../utils/version';
import { ToolValidation, Validator, ValidationError } from '../utils/validation-schemas';
import {
  negotiateProtocolVersion,
  logProtocolNegotiation,
} from '../utils/protocol-version';
import { InstanceContext } from '../types/instance-context';
import { telemetry } from '../telemetry';
import { EarlyErrorLogger } from '../telemetry/early-error-logger';
import { STARTUP_CHECKPOINTS } from '../telemetry/startup-checkpoints';
import { GenericObject, ToolArguments, ToolResult } from '../types/common-types';

// Import refactored handlers
import {
  getDatabaseStatistics,
  listAITools,
  listNodes,
  getToolsDocumentation,
} from './handlers/utility-handlers';

import {
  getNodeInfo,
  getNodeEssentials,
  getNode,
  getNodeDocumentation,
  searchNodeProperties,
  getNodeAsToolInfo,
  validateNodeMinimal,
  validateNodeConfig,
  NodeHandlerDeps,
} from './handlers/node-handlers';

import {
  searchNodes,
  SearchHandlerDeps,
} from './handlers/search-handlers';

import {
  listTemplates,
  listNodeTemplates,
  getTemplate,
  searchTemplates,
  getTemplatesForTask,
  searchTemplatesByMetadata,
  TemplateHandlerDeps,
} from './handlers/template-handlers';

import {
  validateWorkflow,
  validateWorkflowConnections,
  validateWorkflowExpressions,
  ValidationHandlerDeps,
} from './handlers/workflow-handlers';

export class N8NDocumentationMCPServer {
  private server: Server;
  private db: DatabaseAdapter | null = null;
  private repository: NodeRepository | null = null;
  private templateService: TemplateService | null = null;
  private initialized: Promise<void>;
  private cache = new SimpleCache();
  private clientInfo: GenericObject | null = null;
  private instanceContext?: InstanceContext;
  private previousTool: string | null = null;
  private previousToolTimestamp: number = Date.now();
  private earlyLogger: EarlyErrorLogger | null = null;
  private disabledToolsCache: Set<string> | null = null;
  private useSharedDatabase: boolean = false;
  private sharedDbState: SharedDatabaseState | null = null;
  private isShutdown: boolean = false;
  private dbHealthChecked: boolean = false;

  constructor(instanceContext?: InstanceContext, earlyLogger?: EarlyErrorLogger) {
    this.instanceContext = instanceContext;
    this.earlyLogger = earlyLogger || null;
    
    const envDbPath = process.env.NODE_DB_PATH;
    let dbPath: string | null = null;
    
    let possiblePaths: string[] = [];
    
    if (envDbPath && (envDbPath === ':memory:' || existsSync(envDbPath))) {
      dbPath = envDbPath;
    } else {
      possiblePaths = [
        path.join(process.cwd(), 'data', 'nodes.db'),
        path.join(__dirname, '../../data', 'nodes.db'),
        './data/nodes.db'
      ];
      
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          dbPath = p;
          break;
        }
      }
    }
    
    if (!dbPath) {
      logger.error('Database not found in any of the expected locations:', possiblePaths);
      throw new Error('Database nodes.db not found. Please run npm run rebuild first.');
    }
    
    this.initialized = this.initializeDatabase(dbPath).then(() => {
      if (this.earlyLogger) {
        this.earlyLogger.logCheckpoint(STARTUP_CHECKPOINTS.N8N_API_CHECKING);
      }

      const apiConfigured = isN8nApiConfigured();
      const totalTools = apiConfigured ?
        n8nDocumentationToolsFinal.length + n8nManagementTools.length :
        n8nDocumentationToolsFinal.length;

      logger.info(`MCP server initialized with ${totalTools} tools (n8n API: ${apiConfigured ? 'configured' : 'not configured'})`);

      if (this.earlyLogger) {
        this.earlyLogger.logCheckpoint(STARTUP_CHECKPOINTS.N8N_API_READY);
      }
    });

    logger.info('Initializing n8n Documentation MCP server');
    
    this.server = new Server(
      {
        name: 'n8n-documentation-mcp',
        version: PROJECT_VERSION,
        icons: [
          {
            src: "https://www.n8n-mcp.com/logo.png",
            mimeType: "image/png",
            sizes: ["192x192"]
          },
          {
            src: "https://www.n8n-mcp.com/logo-128.png",
            mimeType: "image/png",
            sizes: ["128x128"]
          },
          {
            src: "https://www.n8n-mcp.com/logo-48.png",
            mimeType: "image/png",
            sizes: ["48x48"]
          }
        ],
        websiteUrl: "https://n8n-mcp.com"
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  async close(): Promise<void> {
    try {
      await this.initialized;
    } catch (error) {
      logger.debug('Initialization had failed, proceeding with cleanup', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.server.close();
      this.cache.destroy();

      if (this.useSharedDatabase && this.sharedDbState) {
        releaseSharedDatabase(this.sharedDbState);
        logger.debug('Released shared database reference');
      } else if (this.db) {
        try {
          this.db.close();
        } catch (dbError) {
          logger.warn('Error closing database', {
            error: dbError instanceof Error ? dbError.message : String(dbError)
          });
        }
      }

      this.db = null;
      this.repository = null;
      this.templateService = null;
      this.earlyLogger = null;
      this.sharedDbState = null;
    } catch (error) {
      logger.warn('Error closing MCP server', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async initializeDatabase(dbPath: string): Promise<void> {
    try {
      if (this.earlyLogger) {
        this.earlyLogger.logCheckpoint(STARTUP_CHECKPOINTS.DATABASE_CONNECTING);
      }

      logger.debug('Database initialization starting...', { dbPath });

      if (dbPath === ':memory:') {
        this.db = await createDatabaseAdapter(dbPath);
        logger.debug('Database adapter created (in-memory mode)');
        await this.initializeInMemorySchema();
        logger.debug('In-memory schema initialized');
        this.repository = new NodeRepository(this.db);
        this.templateService = new TemplateService(this.db);
        EnhancedConfigValidator.initializeSimilarityServices(this.repository);
        this.useSharedDatabase = false;
      } else {
        const sharedState = await getSharedDatabase(dbPath);
        this.db = sharedState.db;
        this.repository = sharedState.repository;
        this.templateService = sharedState.templateService;
        this.sharedDbState = sharedState;
        this.useSharedDatabase = true;
        logger.debug('Using shared database connection');
      }

      logger.debug('Node repository initialized');
      logger.debug('Template service initialized');
      logger.debug('Similarity services initialized');

      if (this.earlyLogger) {
        this.earlyLogger.logCheckpoint(STARTUP_CHECKPOINTS.DATABASE_CONNECTED);
      }

      logger.info(`Database initialized successfully from: ${dbPath}`);
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw new Error(`Failed to open database: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async initializeInMemorySchema(): Promise<void> {
    if (!this.db) return;

    const schemaPath = path.join(__dirname, '../../src/database/schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');
    const statements = this.parseSQLStatements(schema);

    for (const statement of statements) {
      if (statement.trim()) {
        try {
          this.db.exec(statement);
        } catch (error) {
          logger.error(`Failed to execute SQL statement: ${statement.substring(0, 100)}...`, error);
          throw error;
        }
      }
    }
  }

  private parseSQLStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inBlock = false;

    const lines = sql.split('\n');

    for (const line of lines) {
      const trimmed = line.trim().toUpperCase();

      if (trimmed.startsWith('--') || trimmed === '') {
        continue;
      }

      if (trimmed.includes('BEGIN')) {
        inBlock = true;
      }

      current += line + '\n';

      if (inBlock && trimmed === 'END;') {
        statements.push(current.trim());
        current = '';
        inBlock = false;
        continue;
      }

      if (!inBlock && trimmed.endsWith(';')) {
        statements.push(current.trim());
        current = '';
      }
    }

    if (current.trim()) {
      statements.push(current.trim());
    }

    return statements.filter(s => s.length > 0);
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
    if (!this.db || !this.repository) {
      throw new Error('Database not initialized');
    }

    if (!this.dbHealthChecked) {
      await this.validateDatabaseHealth();
      this.dbHealthChecked = true;
    }
  }

  private async validateDatabaseHealth(): Promise<void> {
    if (!this.db) return;

    try {
      const nodeCount = this.db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number };

      if (nodeCount.count === 0) {
        logger.error('CRITICAL: Database is empty - no nodes found! Please run: npm run rebuild');
        throw new Error('Database is empty. Run "npm run rebuild" to populate node data.');
      }

      try {
        const ftsExists = this.db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name='nodes_fts'
        `).get();

        if (!ftsExists) {
          logger.warn('FTS5 table missing - search performance will be degraded. Please run: npm run rebuild');
        } else {
          const ftsCount = this.db.prepare('SELECT COUNT(*) as count FROM nodes_fts').get() as { count: number };
          if (ftsCount.count === 0) {
            logger.warn('FTS5 index is empty - search will not work properly. Please run: npm run rebuild');
          }
        }
      } catch (ftsError) {
        logger.warn('FTS5 not available - using fallback search. For better performance, ensure better-sqlite3 is properly installed.');
      }

      logger.info(`Database health check passed: ${nodeCount.count} nodes loaded`);
    } catch (error) {
      logger.error('Database health check failed:', error);
      throw error;
    }
  }

  private getDisabledTools(): Set<string> {
    if (this.disabledToolsCache !== null) {
      return this.disabledToolsCache;
    }

    let disabledToolsEnv = process.env.DISABLED_TOOLS || '';
    if (!disabledToolsEnv) {
      this.disabledToolsCache = new Set();
      return this.disabledToolsCache;
    }

    if (disabledToolsEnv.length > 10000) {
      logger.warn(`DISABLED_TOOLS environment variable too long (${disabledToolsEnv.length} chars), truncating to 10000`);
      disabledToolsEnv = disabledToolsEnv.substring(0, 10000);
    }

    let tools = disabledToolsEnv
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    if (tools.length > 200) {
      logger.warn(`DISABLED_TOOLS contains ${tools.length} tools, limiting to first 200`);
      tools = tools.slice(0, 200);
    }

    if (tools.length > 0) {
      logger.info(`Disabled tools configured: ${tools.join(', ')}`);
    }

    this.disabledToolsCache = new Set(tools);
    return this.disabledToolsCache;
  }

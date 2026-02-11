import { logger } from '../../utils/logger';
import { ToolArguments, ToolResult, GenericObject, WorkflowValidationOptions, WorkflowValidationResponse } from '../../types/common-types';
import { DatabaseAdapter } from '../database/database-adapter';
import { NodeRepository } from '../database/node-repository';
import { TemplateService } from '../templates/template-service';
import { InstanceContext } from '../types/instance-context';
import { SimpleCache } from '../utils/simple-cache';
import { NodeTypeNormalizer } from '../../utils/node-type-normalizer';
import { getNodeTypeAlternatives, getWorkflowNodeType } from '../../utils/node-utils';
import { PropertyFilter } from '../../services/property-filter';
import { EnhancedConfigValidator, ValidationMode, ValidationProfile } from '../../services/enhanced-config-validator';
import { PropertyDependencies } from '../../services/property-dependencies';
import * as n8nHandlers from '../mcp/handlers-n8n-manager';
import { handleUpdatePartialWorkflow } from '../mcp/handlers-workflow-diff';
import { trackPerformance, withPerformanceTracking } from '../../monitoring/performance-tracking';
import { searchNodes as searchNodesHandler } from '../mcp/handlers/search-handlers';
import {
  getNode as getNodeHandler,
  getNodeDocumentation as getNodeDocumentationHandler,
  searchNodeProperties as searchNodePropertiesHandler,
  validateNodeMinimal as validateNodeMinimalHandler,
  validateNodeConfig as validateNodeConfigHandler
} from '../mcp/handlers/node-handlers';
import { validateWorkflow as validateWorkflowHandler } from '../mcp/handlers/workflow-handlers';
import {
  listNodeTemplates as listNodeTemplatesHandler,
  getTemplate as getTemplateHandler,
  searchTemplates as searchTemplatesHandler,
  getTemplatesForTask as getTemplatesForTaskHandler,
  searchTemplatesByMetadata as searchTemplatesByMetadataHandler
} from '../mcp/handlers/template-handlers';
import { getToolDocumentation, getToolsOverview } from '../mcp/tools-documentation';

export class ToolExecutionHandler {
  constructor(
    private repository: NodeRepository | null,
    private templateService: TemplateService | null,
    private instanceContext?: InstanceContext,
    private ensureInitializedCallback?: () => Promise<void>,
    private validateToolParamsCallback?: (name: string, args: ToolArguments, required: string[]) => void,
    private db?: DatabaseAdapter,
    private cache?: SimpleCache
  ) {}

  async executeTool(name: string, args: ToolArguments): Promise<ToolResult> {
    args = args || {};

    logger.info(`Tool execution: ${name}`, {
      args: typeof args === 'object' ? JSON.stringify(args) : args,
      argsType: typeof args,
      argsKeys: typeof args === 'object' ? Object.keys(args) : 'not-object'
    });

    if (typeof args !== 'object' || args === null) {
      throw new Error(`Invalid arguments for tool ${name}: expected object, got ${typeof args}`);
    }

    switch (name) {
      case 'tools_documentation':
        return this.getToolsDocumentation(args.topic, args.depth);
        
      case 'search_nodes':
        this.validateToolParams(name, args, ['query']);
        const limit = args.limit !== undefined ? Number(args.limit) || 20 : 20;
        return this.searchNodes(args.query, limit, {
          mode: args.mode,
          includeExamples: args.includeExamples,
          source: args.source
        });
        
      case 'get_node':
        this.validateToolParams(name, args, ['nodeType']);
        if (args.mode === 'docs') {
          return this.getNodeDocumentation(args.nodeType);
        }
        if (args.mode === 'search_properties') {
          if (!args.propertyQuery) {
            throw new Error('propertyQuery is required for mode=search_properties');
          }
          const maxResults = args.maxPropertyResults !== undefined ? Number(args.maxPropertyResults) || 20 : 20;
          return this.searchNodeProperties(args.nodeType, args.propertyQuery, maxResults);
        }
        return this.getNode(
          args.nodeType,
          args.detail,
          args.mode,
          args.includeTypeInfo,
          args.includeExamples,
          args.fromVersion,
          args.toVersion
        );
        
      case 'validate_node':
        this.validateToolParams(name, args, ['nodeType', 'config']);
        if (typeof args.config !== 'object' || args.config === null) {
          logger.warn(`validate_node called with invalid config type: ${typeof args.config}`);
          const validationMode = args.mode || 'full';
          if (validationMode === 'minimal') {
            return {
              nodeType: args.nodeType || 'unknown',
              displayName: 'Unknown Node',
              valid: false,
              missingRequiredFields: [
                'Invalid config format - expected object',
                '🔧 RECOVERY: Use format { "resource": "...", "operation": "..." } or {} for empty config'
              ]
            };
          }
          return {
            nodeType: args.nodeType || 'unknown',
            workflowNodeType: args.nodeType || 'unknown',
            displayName: 'Unknown Node',
            valid: false,
            errors: [{
              type: 'config',
              property: 'config',
              message: 'Invalid config format - expected object',
              fix: 'Provide config as an object with node properties'
            }],
            warnings: [],
            suggestions: [
              '🔧 RECOVERY: Invalid config detected. Fix with:',
              '   • Ensure config is an object: { "resource": "...", "operation": "..." }',
              '   • Use get_node to see required fields for this node type',
              '   • Check if the node type is correct before configuring it'
            ],
            summary: {
              hasErrors: true,
              errorCount: 1,
              warningCount: 0,
              suggestionCount: 3
            }
          };
        }
        const validationMode = args.mode || 'full';
        if (validationMode === 'minimal') {
          return this.validateNodeMinimal(args.nodeType, args.config);
        }
        return this.validateNodeConfig(args.nodeType, args.config, 'operation', args.profile);
        
      case 'get_template':
        this.validateToolParams(name, args, ['templateId']);
        const templateId = Number(args.templateId);
        const templateMode = args.mode || 'full';
        return this.getTemplate(templateId, templateMode);
        
      case 'search_templates': {
        const searchMode = args.searchMode || 'keyword';
        const searchLimit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        const searchOffset = Math.max(Number(args.offset) || 0, 0);

        switch (searchMode) {
          case 'by_nodes':
            if (!args.nodeTypes || !Array.isArray(args.nodeTypes) || args.nodeTypes.length === 0) {
              throw new Error('nodeTypes array is required for searchMode=by_nodes');
            }
            return this.listNodeTemplates(args.nodeTypes, searchLimit, searchOffset);
          case 'by_task':
            if (!args.task) {
              throw new Error('task is required for searchMode=by_task');
            }
            return this.getTemplatesForTask(args.task, searchLimit, searchOffset);
          case 'by_metadata':
            return this.searchTemplatesByMetadata({
              category: args.category,
              complexity: args.complexity,
              maxSetupMinutes: args.maxSetupMinutes ? Number(args.maxSetupMinutes) : undefined,
              minSetupMinutes: args.minSetupMinutes ? Number(args.minSetupMinutes) : undefined,
              requiredService: args.requiredService,
              targetAudience: args.targetAudience
            }, searchLimit, searchOffset);
          case 'keyword':
          default:
            if (!args.query) {
              throw new Error('query is required for searchMode=keyword');
            }
            const searchFields = args.fields as string[] | undefined;
            return this.searchTemplates(args.query, searchLimit, searchOffset, searchFields);
        }
      }
        
      case 'validate_workflow':
        this.validateToolParams(name, args, ['workflow']);
        return this.validateWorkflow(args.workflow, args.options);

      // n8n Management Tools
      case 'n8n_create_workflow':
        this.validateToolParams(name, args, ['name', 'nodes', 'connections']);
        return n8nHandlers.handleCreateWorkflow(args, this.instanceContext);
        
      case 'n8n_get_workflow': {
        this.validateToolParams(name, args, ['id']);
        const workflowMode = args.mode || 'full';
        switch (workflowMode) {
          case 'details':
            return n8nHandlers.handleGetWorkflowDetails(args, this.instanceContext);
          case 'structure':
            return n8nHandlers.handleGetWorkflowStructure(args, this.instanceContext);
          case 'minimal':
            return n8nHandlers.handleGetWorkflowMinimal(args, this.instanceContext);
          case 'full':
          default:
            return n8nHandlers.handleGetWorkflow(args, this.instanceContext);
        }
      }
        
      case 'n8n_update_full_workflow':
        this.validateToolParams(name, args, ['id']);
        return n8nHandlers.handleUpdateWorkflow(args, this.repository, this.instanceContext);
        
      case 'n8n_update_partial_workflow':
        this.validateToolParams(name, args, ['id', 'operations']);
        return handleUpdatePartialWorkflow(args, this.repository, this.instanceContext);
        
      case 'n8n_delete_workflow':
        this.validateToolParams(name, args, ['id']);
        return n8nHandlers.handleDeleteWorkflow(args, this.instanceContext);
        
      case 'n8n_list_workflows':
        return n8nHandlers.handleListWorkflows(args, this.instanceContext);
        
      case 'n8n_validate_workflow':
        this.validateToolParams(name, args, ['id']);
        await this.ensureInitialized();
        if (!this.repository) throw new Error('Repository not initialized');
        return n8nHandlers.handleValidateWorkflow(args, this.repository, this.instanceContext);
        
      case 'n8n_autofix_workflow':
        this.validateToolParams(name, args, ['id']);
        await this.ensureInitialized();
        if (!this.repository) throw new Error('Repository not initialized');
        return n8nHandlers.handleAutofixWorkflow(args, this.repository, this.instanceContext);
        
      case 'n8n_test_workflow':
        this.validateToolParams(name, args, ['workflowId']);
        return n8nHandlers.handleTestWorkflow(args, this.instanceContext);
        
      case 'n8n_executions': {
        this.validateToolParams(name, args, ['action']);
        const execAction = args.action;
        switch (execAction) {
          case 'list':
            return n8nHandlers.handleListExecutions(args, this.instanceContext);
          case 'get':
            this.validateToolParams(name, args, ['executionId']);
            return n8nHandlers.handleGetExecution(args, this.instanceContext);
          case 'retry':
            this.validateToolParams(name, args, ['executionId']);
            return n8nHandlers.handleRetryExecution(args, this.instanceContext);
          case 'cancel':
            this.validateToolParams(name, args, ['executionId']);
            return n8nHandlers.handleCancelExecution(args, this.instanceContext);
          case 'delete':
            this.validateToolParams(name, args, ['executionId']);
            return n8nHandlers.handleDeleteExecution(args, this.instanceContext);
          default:
            throw new Error(`Unknown execution action: ${execAction}`);
        }
      }
        
      case 'n8n_health_check':
        return n8nHandlers.handleHealthCheck(this.instanceContext);
        
      case 'n8n_workflow_versions':
        this.validateToolParams(name, args, ['mode']);
        return n8nHandlers.handleWorkflowVersions(args, this.repository, this.instanceContext);

      case 'n8n_deploy_template':
        this.validateToolParams(name, args, ['templateId']);
        await this.ensureInitialized();
        if (!this.templateService) throw new Error('Template service not initialized');
        if (!this.repository) throw new Error('Repository not initialized');
        return n8nHandlers.handleDeployTemplate(args, this.templateService, this.repository, this.instanceContext);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private validateToolParams(name: string, args: ToolArguments, required: string[]): void {
    if (this.validateToolParamsCallback) {
      this.validateToolParamsCallback(name, args, required);
    }
    for (const param of required) {
      if (!(param in args) || args[param] === undefined || args[param] === null) {
        throw new Error(`Missing required parameter '${param}' for tool '${name}'`);
      }
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.ensureInitializedCallback) {
      await this.ensureInitializedCallback();
    }
  }

  private async getToolsDocumentation(topic?: string, depth: 'essentials' | 'full' = 'essentials'): Promise<string> {
    if (!topic || topic === 'overview') {
      return getToolsOverview(depth);
    }
    return getToolDocumentation(topic, depth);
  }

  private async searchNodes(query: string, limit: number, options?: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return searchNodesHandler(query, limit, options, { db: this.db });
  }

  private async getNodeDocumentation(nodeType: string): Promise<unknown> {
    await this.ensureInitialized();
    return getNodeDocumentationHandler(nodeType, { db: this.db, repository: this.repository, cache: this.cache });
  }

  private async searchNodeProperties(nodeType: string, query: string, maxResults: number = 20): Promise<unknown> {
    await this.ensureInitialized();
    return searchNodePropertiesHandler(nodeType, query, maxResults, { db: this.db, repository: this.repository, cache: this.cache });
  }

  private async getNode(nodeType: string, detail?: string, mode?: string, includeTypeInfo?: boolean, includeExamples?: boolean, fromVersion?: string, toVersion?: string): Promise<unknown> {
    await this.ensureInitialized();
    return getNodeHandler(
      nodeType,
      detail || 'standard',
      mode || 'info',
      includeTypeInfo,
      includeExamples,
      fromVersion,
      toVersion,
      { db: this.db, repository: this.repository, cache: this.cache }
    );
  }

  private async validateNodeMinimal(nodeType: string, config: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return validateNodeMinimalHandler(nodeType, config, { db: this.db, repository: this.repository, cache: this.cache });
  }

  private async validateNodeConfig(nodeType: string, config: Record<string, unknown>, mode: ValidationMode, profile?: ValidationProfile): Promise<unknown> {
    await this.ensureInitialized();
    return validateNodeConfigHandler(nodeType, config, mode, profile || 'ai-friendly', { db: this.db, repository: this.repository, cache: this.cache });
  }

  private async getTemplate(templateId: number, mode: string): Promise<unknown> {
    await this.ensureInitialized();
    return getTemplateHandler(templateId, mode as 'nodes_only' | 'structure' | 'full', { templateService: this.templateService });
  }

  private async listNodeTemplates(nodeTypes: string[], limit: number, offset: number): Promise<unknown> {
    await this.ensureInitialized();
    return listNodeTemplatesHandler(nodeTypes, limit, offset, { templateService: this.templateService });
  }

  private async getTemplatesForTask(task: string, limit: number, offset: number): Promise<unknown> {
    await this.ensureInitialized();
    return getTemplatesForTaskHandler(task, limit, offset, { templateService: this.templateService });
  }

  private async searchTemplatesByMetadata(filters: Record<string, unknown>, limit: number, offset: number): Promise<unknown> {
    await this.ensureInitialized();
    return searchTemplatesByMetadataHandler(filters, limit, offset, { templateService: this.templateService });
  }

  private async searchTemplates(query: string, limit: number, offset: number, fields?: string[]): Promise<unknown> {
    await this.ensureInitialized();
    return searchTemplatesHandler(query, limit, offset, fields, { templateService: this.templateService });
  }

  private async validateWorkflow(workflow: GenericObject, options?: WorkflowValidationOptions): Promise<WorkflowValidationResponse> {
    await this.ensureInitialized();
    return validateWorkflowHandler(workflow, options, { repository: this.repository }) as Promise<WorkflowValidationResponse>;
  }
}
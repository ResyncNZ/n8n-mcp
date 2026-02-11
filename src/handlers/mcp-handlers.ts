import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InitializeRequestSchema, ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger';
import { telemetry } from '../../telemetry';
import { PROJECT_VERSION } from '../../utils/version';
import { negotiateProtocolVersion, logProtocolNegotiation, STANDARD_PROTOCOL_VERSION } from '../../utils/protocol-version';
import { GenericObject, ToolArguments, StdoutWriteFunction } from '../../types/common-types';
import { n8nDocumentationToolsFinal } from '../mcp/tools';
import { n8nManagementTools } from '../mcp/tools-n8n-manager';
import { makeToolsN8nFriendly } from '../mcp/tools-n8n-friendly';
import { isN8nApiConfigured } from '../../config/n8n-api';
import { McpMonitoring } from '../../monitoring';

export class McpRequestHandlers {
  private disabledToolsCache: Set<string> | null = null;
  private clientInfo: Record<string, unknown> | null = null;
  private previousTool: string | null = null;
  private previousToolTimestamp: number = 0;
  private monitoringInitialized = false;

  constructor(
    private server: Server,
    private executeToolCallback: (name: string, args: ToolArguments) => Promise<unknown>,
    private getDisabledToolsCallback: () => Set<string>,
    private instanceContext?: Record<string, unknown>
  ) {
    this.monitoringInitialized = !!process.env.N8N_MCP_MONITORING_ENABLED;
  }

  setupHandlers(): void {
    this.setupInitializeHandler();
    this.setupListToolsHandler();
    this.setupCallToolHandler();
  }

  private setupInitializeHandler(): void {
    this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      const clientVersion = request.params.protocolVersion;
      const clientCapabilities = request.params.capabilities;
      const clientInfo = request.params.clientInfo;
      
      logger.info('MCP Initialize request received', {
        clientVersion,
        clientCapabilities,
        clientInfo
      });

      telemetry.trackSessionStart();

      this.clientInfo = clientInfo;
      
      const negotiationResult = negotiateProtocolVersion(
        clientVersion,
        clientInfo,
        undefined, // no user agent in MCP protocol
        undefined  // no headers in MCP protocol
      );
      
      logProtocolNegotiation(negotiationResult, logger, 'MCP_INITIALIZE');
      
      if (clientVersion && clientVersion !== negotiationResult.version) {
        logger.warn(`Protocol version negotiated: client requested ${clientVersion}, server will use ${negotiationResult.version}`, {
          reasoning: negotiationResult.reasoning
        });
      }
      
      const response = {
        protocolVersion: negotiationResult.version,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'n8n-documentation-mcp',
          version: PROJECT_VERSION,
        },
      };
      
      logger.info('MCP Initialize response', { response });
      return response;
    });
  }

  private setupListToolsHandler(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const transaction = this.monitoringInitialized ? 
        McpMonitoring.startTransaction('list_tools', 'mcp.operation') : null;

      const disabledTools = this.getDisabledToolsCallback();

      const enabledDocTools = n8nDocumentationToolsFinal.filter(
        tool => !disabledTools.has(tool.name)
      );

      let tools = [...enabledDocTools];

      const hasEnvConfig = isN8nApiConfigured();
      const hasInstanceConfig = !!(this.instanceContext?.n8nApiUrl && this.instanceContext?.n8nApiKey);
      const isMultiTenantEnabled = process.env.ENABLE_MULTI_TENANT === 'true';

      const shouldIncludeManagementTools = hasEnvConfig || hasInstanceConfig || isMultiTenantEnabled;

      if (shouldIncludeManagementTools) {
        const enabledMgmtTools = n8nManagementTools.filter(
          tool => !disabledTools.has(tool.name)
        );
        tools.push(...enabledMgmtTools);
        logger.debug(`Tool listing: ${tools.length} tools available (${enabledDocTools.length} documentation + ${enabledMgmtTools.length} management)`, {
          hasEnvConfig,
          hasInstanceConfig,
          isMultiTenantEnabled,
          disabledToolsCount: disabledTools.size
        });
      } else {
        logger.debug(`Tool listing: ${tools.length} tools available (documentation only)`, {
          hasEnvConfig,
          hasInstanceConfig,
          isMultiTenantEnabled,
          disabledToolsCount: disabledTools.size
        });
      }

      if (disabledTools.size > 0) {
        const totalAvailableTools = n8nDocumentationToolsFinal.length + (shouldIncludeManagementTools ? n8nManagementTools.length : 0);
        logger.debug(`Filtered ${disabledTools.size} disabled tools, ${tools.length}/${totalAvailableTools} tools available`);
      }
      
      const clientInfo = this.clientInfo;
      const isN8nClient = clientInfo?.name?.includes('n8n') || 
                         clientInfo?.name?.includes('langchain');
      
      if (isN8nClient) {
        logger.info('Detected n8n client, using n8n-friendly tool descriptions');
        tools = makeToolsN8nFriendly(tools);
      }
      
      const validationTools = tools.filter(t => t.name.startsWith('validate_'));
      validationTools.forEach(tool => {
        logger.info('Validation tool schema', {
          toolName: tool.name,
          inputSchema: JSON.stringify(tool.inputSchema, null, 2),
          hasOutputSchema: !!tool.outputSchema,
          description: tool.description
        });
      });
      
      const result = { tools };
      
      if (transaction) {
        transaction.finish();
        McpMonitoring.trackWorkflowOperation('list_tools', undefined, tools.length, 0, true);
      }
      
      return result;
    });
  }

  private setupCallToolHandler(): void {
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const startTime = Date.now();
      
      const transaction = this.monitoringInitialized ? 
        McpMonitoring.startTransaction('call_tool', 'mcp.operation') : null;
      const span = transaction ? 
        McpMonitoring.startSpan(transaction, name, 'tool.execution') : null;
      
      logger.info('Tool call received - DETAILED DEBUG', {
        toolName: name,
        arguments: JSON.stringify(args, null, 2),
        argumentsType: typeof args,
        argumentsKeys: args ? Object.keys(args) : [],
        hasNodeType: args && 'nodeType' in args,
        hasConfig: args && 'config' in args,
        configType: args && args.config ? typeof args.config : 'N/A',
        rawRequest: JSON.stringify(request.params)
      });

      const disabledTools = this.getDisabledToolsCallback();
      if (disabledTools.has(name)) {
        logger.warn(`Attempted to call disabled tool: ${name}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'TOOL_DISABLED',
              message: `Tool '${name}' is not available in this deployment. It has been disabled via DISABLED_TOOLS environment variable.`,
              tool: name
            }, null, 2)
          }]
        };
      }

      let processedArgs = args;
      if (args && typeof args === 'object' && 'output' in args) {
        try {
          const possibleNestedData = args.output;
          if (typeof possibleNestedData === 'string' && possibleNestedData.trim().startsWith('{')) {
            const parsed = JSON.parse(possibleNestedData);
            if (parsed && typeof parsed === 'object') {
              logger.warn('Detected n8n nested output bug, attempting to extract actual arguments', {
                originalArgs: args,
                extractedArgs: parsed
              });
              
              if (this.validateExtractedArgs(name, parsed)) {
                processedArgs = parsed;
              } else {
                logger.warn('Extracted arguments failed validation, using original args', {
                  toolName: name,
                  extractedArgs: parsed
                });
              }
            }
          }
        } catch (parseError) {
          logger.debug('Failed to parse nested output, continuing with original args', { 
            error: parseError instanceof Error ? parseError.message : String(parseError) 
          });
        }
      }
      
      try {
        logger.debug(`Executing tool: ${name}`, { args: processedArgs });
        const startTime = Date.now();
        const result = await this.executeToolCallback(name, processedArgs);
        const duration = Date.now() - startTime;
        logger.debug(`Tool ${name} executed successfully`);

        telemetry.trackToolUsage(name, true, duration);

        if (this.previousTool) {
          const timeDelta = Date.now() - this.previousToolTimestamp;
          telemetry.trackToolSequence(this.previousTool, name, timeDelta);
        }

        this.previousTool = name;
        this.previousToolTimestamp = Date.now();
        
        if (this.monitoringInitialized) {
          McpMonitoring.trackWorkflowOperation(name, undefined, undefined, duration, true);
        }
        
        let responseText: string;
        let structuredContent: GenericObject | null = null;
        
        try {
          if (name.startsWith('validate_') && typeof result === 'object' && result !== null) {
            const cleanResult = this.sanitizeValidationResult(result, name);
            structuredContent = cleanResult;
            responseText = JSON.stringify(cleanResult, null, 2);
          } else {
            responseText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          }
        } catch (jsonError) {
          logger.warn(`Failed to stringify tool result for ${name}:`, jsonError);
          responseText = String(result);
        }
        
        if (responseText.length > 1000000) {
          logger.warn(`Tool ${name} response is very large (${responseText.length} chars), truncating`);
          responseText = responseText.substring(0, 999000) + '\n\n[Response truncated due to size limits]';
          structuredContent = null;
        }
        
        const mcpResponse: GenericObject = {
          content: [
            {
              type: 'text' as const,
              text: responseText,
            },
          ],
        };
        
        if (name.startsWith('validate_') && structuredContent !== null) {
          mcpResponse.structuredContent = structuredContent;
        }
        
        if (span) {
          McpMonitoring.finishSpan(span, { 
            toolName: name,
            responseSize: responseText.length,
            hasStructuredContent: !!structuredContent
          });
        }
        if (transaction) {
          transaction.finish();
        }
        
        return mcpResponse;
      } catch (error) {
        logger.error(`Error executing tool ${name}`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        telemetry.trackToolUsage(name, false);
        telemetry.trackError(
          error instanceof Error ? error.constructor.name : 'UnknownError',
          `tool_execution`,
          name,
          errorMessage
        );

        if (this.previousTool) {
          const timeDelta = Date.now() - this.previousToolTimestamp;
          telemetry.trackToolSequence(this.previousTool, name, timeDelta);
        }

        this.previousTool = name;
        this.previousToolTimestamp = Date.now();

        let helpfulMessage = `Error executing tool ${name}: ${errorMessage}`;
        
        if (errorMessage.includes('required') || errorMessage.includes('missing')) {
          helpfulMessage += '\n\nNote: This error often occurs when the AI agent sends incomplete or incorrectly formatted parameters. Please ensure all required fields are provided with the correct types.';
        } else if (errorMessage.includes('type') || errorMessage.includes('expected')) {
          helpfulMessage += '\n\nNote: This error indicates a type mismatch. The AI agent may be sending data in the wrong format (e.g., string instead of object).';
        } else if (errorMessage.includes('Unknown category') || errorMessage.includes('not found')) {
          helpfulMessage += '\n\nNote: The requested resource or category was not found. Please check the available options.';
        }
        
        if (name.startsWith('validate_') && (errorMessage.includes('config') || errorMessage.includes('nodeType'))) {
          helpfulMessage += '\n\nFor validation tools:\n- nodeType should be a string (e.g., "nodes-base.webhook")\n- config should be an object (e.g., {})';
        }
        
        return {
          content: [
            {
              type: 'text',
              text: helpfulMessage,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private validateExtractedArgs(toolName: string, extractedArgs: Record<string, unknown>): boolean {
    // Basic validation - this should be enhanced based on tool schemas
    if (!extractedArgs || typeof extractedArgs !== 'object') {
      return false;
    }

    // Check for common required parameters based on tool name patterns
    if (toolName.includes('node') && !extractedArgs.nodeType) {
      return false;
    }
    
    if (toolName.includes('validate') && !extractedArgs.config) {
      return false;
    }

    return true;
  }

  private sanitizeValidationResult(result: GenericObject, toolName: string): GenericObject {
    if (!result || typeof result !== 'object') {
      return result as GenericObject;
    }

    const sanitized = { ...result };

    if (toolName === 'validate_node_minimal') {
      const filtered = {
        nodeType: String(sanitized.nodeType || ''),
        displayName: String(sanitized.displayName || ''),
        valid: Boolean(sanitized.valid),
        missingRequiredFields: Array.isArray(sanitized.missingRequiredFields) ? sanitized.missingRequiredFields : [],
        errors: Array.isArray(sanitized.errors) ? sanitized.errors : []
      };
      return filtered;
    }

    // For other validation tools, filter to schema-defined fields
    const schemaFields = [
      'nodeType', 'workflowNodeType', 'displayName', 'valid', 
      'errors', 'warnings', 'suggestions', 'summary'
    ];
    
    const filtered: GenericObject = {};
    schemaFields.forEach(field => {
      if (field in sanitized) {
        filtered[field] = sanitized[field];
      }
    });

    return filtered;
  }
}
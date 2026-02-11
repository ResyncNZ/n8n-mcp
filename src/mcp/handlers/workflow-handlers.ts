import { NodeRepository } from '../../database/node-repository';
import { EnhancedConfigValidator } from '../../services/enhanced-config-validator';
import { WorkflowValidator } from '../../services/workflow-validator';
import { logger } from '../../utils/logger';
import { telemetry } from '../../telemetry';
import { getWorkflowExampleString } from '../workflow-examples';

export interface ValidationHandlerDeps {
  repository: NodeRepository;
}

/**
 * Validate workflow
 */
export async function validateWorkflow(
  workflow: unknown,
  options: unknown,
  deps: ValidationHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;
  
  logger.info('Workflow validation requested', {
    hasWorkflow: !!workflow,
    workflowType: typeof workflow,
    hasNodes: (workflow as Record<string, unknown>)?.nodes !== undefined,
    nodesType: (workflow as Record<string, unknown>)?.nodes ? typeof (workflow as Record<string, unknown>).nodes : 'undefined',
    nodesIsArray: Array.isArray((workflow as Record<string, unknown>)?.nodes),
    nodesCount: Array.isArray((workflow as Record<string, unknown>)?.nodes) ? ((workflow as Record<string, unknown>).nodes as unknown[]).length : 0,
    hasConnections: (workflow as Record<string, unknown>)?.connections !== undefined,
    connectionsType: (workflow as Record<string, unknown>)?.connections ? typeof (workflow as Record<string, unknown>).connections : 'undefined',
    options
  });
  
  if (!workflow || typeof workflow !== 'object') {
    return {
      valid: false,
      errors: [{
        node: 'workflow',
        message: 'Workflow must be an object with nodes and connections',
        details: 'Expected format: ' + getWorkflowExampleString()
      }],
      summary: { errorCount: 1 }
    };
  }
  
  const wf = workflow as Record<string, unknown>;
  
  if (!wf.nodes || !Array.isArray(wf.nodes)) {
    return {
      valid: false,
      errors: [{
        node: 'workflow',
        message: 'Workflow must have a nodes array',
        details: 'Expected: workflow.nodes = [array of node objects]. ' + getWorkflowExampleString()
      }],
      summary: { errorCount: 1 }
    };
  }
  
  if (!wf.connections || typeof wf.connections !== 'object') {
    return {
      valid: false,
      errors: [{
        node: 'workflow',
        message: 'Workflow must have a connections object',
        details: 'Expected: workflow.connections = {} (can be empty object). ' + getWorkflowExampleString()
      }],
      summary: { errorCount: 1 }
    };
  }
  
  const validator = new WorkflowValidator(
    repository,
    EnhancedConfigValidator
  );
  
  try {
    const result = await validator.validateWorkflow(wf, options);
    
    const response: Record<string, unknown> = {
      valid: result.valid,
      summary: {
        totalNodes: result.statistics.totalNodes,
        enabledNodes: result.statistics.enabledNodes,
        triggerNodes: result.statistics.triggerNodes,
        validConnections: result.statistics.validConnections,
        invalidConnections: result.statistics.invalidConnections,
        expressionsValidated: result.statistics.expressionsValidated,
        errorCount: result.errors.length,
        warningCount: result.warnings.length
      },
      errors: result.errors.map(e => ({
        node: e.nodeName || 'workflow',
        message: e.message,
        details: e.details
      })),
      warnings: result.warnings.map(w => ({
        node: w.nodeName || 'workflow',
        message: w.message,
        details: w.details
      }))
    };
    
    if (result.suggestions.length > 0) {
      response.suggestions = result.suggestions;
    }

    if (!result.valid && result.errors.length > 0) {
      result.errors.forEach(error => {
        telemetry.trackValidationDetails(
          error.nodeName || 'workflow',
          error.type || 'validation_error',
          {
            message: error.message,
            nodeCount: (wf.nodes as unknown[])?.length ?? 0,
            hasConnections: Object.keys((wf.connections as Record<string, unknown>) || {}).length > 0
          }
        );
      });
    }

    if (result.valid) {
      telemetry.trackWorkflowCreation(wf, true);
    }

    return response;
  } catch (error) {
    logger.error('Error validating workflow:', error);
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error validating workflow',
      tip: 'Ensure the workflow JSON includes nodes array and connections object'
    };
  }
}

/**
 * Validate workflow connections only
 */
export async function validateWorkflowConnections(
  workflow: unknown,
  deps: ValidationHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;
  
  const validator = new WorkflowValidator(
    repository,
    EnhancedConfigValidator
  );
  
  try {
    const result = await validator.validateWorkflow(workflow as Record<string, unknown>, {
      validateNodes: false,
      validateConnections: true,
      validateExpressions: false
    });
    
    const response: Record<string, unknown> = {
      valid: result.errors.length === 0,
      statistics: {
        totalNodes: result.statistics.totalNodes,
        triggerNodes: result.statistics.triggerNodes,
        validConnections: result.statistics.validConnections,
        invalidConnections: result.statistics.invalidConnections
      }
    };
    
    const connectionErrors = result.errors.filter(e => 
      e.message.includes('connection') || 
      e.message.includes('cycle') ||
      e.message.includes('orphaned')
    );
    
    const connectionWarnings = result.warnings.filter(w => 
      w.message.includes('connection') || 
      w.message.includes('orphaned') ||
      w.message.includes('trigger')
    );
    
    if (connectionErrors.length > 0) {
      response.errors = connectionErrors.map(e => ({
        node: e.nodeName || 'workflow',
        message: e.message
      }));
    }
    
    if (connectionWarnings.length > 0) {
      response.warnings = connectionWarnings.map(w => ({
        node: w.nodeName || 'workflow',
        message: w.message
      }));
    }
    
    return response;
  } catch (error) {
    logger.error('Error validating workflow connections:', error);
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error validating connections'
    };
  }
}

/**
 * Validate workflow expressions only
 */
export async function validateWorkflowExpressions(
  workflow: unknown,
  deps: ValidationHandlerDeps
): Promise<Record<string, unknown>> {
  const { repository } = deps;
  
  const validator = new WorkflowValidator(
    repository,
    EnhancedConfigValidator
  );
  
  try {
    const result = await validator.validateWorkflow(workflow as Record<string, unknown>, {
      validateNodes: false,
      validateConnections: false,
      validateExpressions: true
    });
    
    const response: Record<string, unknown> = {
      valid: result.errors.length === 0,
      statistics: {
        totalNodes: result.statistics.totalNodes,
        expressionsValidated: result.statistics.expressionsValidated
      }
    };
    
    const expressionErrors = result.errors.filter(e => 
      e.message.includes('Expression') || 
      e.message.includes('$') ||
      e.message.includes('{{')
    );
    
    const expressionWarnings = result.warnings.filter(w => 
      w.message.includes('Expression') || 
      w.message.includes('$') ||
      w.message.includes('{{')
    );
    
    if (expressionErrors.length > 0) {
      response.errors = expressionErrors.map(e => ({
        node: e.nodeName || 'workflow',
        message: e.message
      }));
    }
    
    if (expressionWarnings.length > 0) {
      response.warnings = expressionWarnings.map(w => ({
        node: w.nodeName || 'workflow',
        message: w.message
      }));
    }
    
    if (expressionErrors.length > 0 || expressionWarnings.length > 0) {
      response.tips = [
        'Use {{ }} to wrap expressions',
        'Reference data with $json.propertyName',
        'Reference other nodes with $node["Node Name"].json',
        'Use $input.item for input data in loops'
      ];
    }
    
    return response;
  } catch (error) {
    logger.error('Error validating workflow expressions:', error);
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error validating expressions'
    };
  }
}

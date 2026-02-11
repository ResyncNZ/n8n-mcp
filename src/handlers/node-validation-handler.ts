import { logger } from '../../utils/logger';
import { GenericObject } from '../../types/common-types';
import { NodeRepository } from '../../database/node-repository';
import { NodeTypeNormalizer } from '../../utils/node-type-normalizer';
import { getNodeTypeAlternatives, getWorkflowNodeType } from '../../utils/node-utils';
import { EnhancedConfigValidator, ValidationMode, ValidationProfile } from '../../services/enhanced-config-validator';
import { PropertyDependencies } from '../../services/property-dependencies';

export class NodeValidationHandler {
  constructor(
    private repository: NodeRepository
  ) {}

  async validateNodeConfig(
    nodeType: string, 
    config: Record<string, any>, 
    mode: ValidationMode = 'operation',
    profile: ValidationProfile = 'ai-friendly'
  ): Promise<unknown> {
    // Get node info to access properties
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
    
    // Get properties
    const properties = node.properties || [];

    // Add @version to config for displayOptions evaluation (supports _cnd operators)
    const configWithVersion = {
      '@version': node.version || 1,
      ...config
    };

    // Use enhanced validator with operation mode by default
    const validationResult = EnhancedConfigValidator.validateWithMode(
      node.nodeType,
      configWithVersion,
      properties,
      mode,
      profile
    );
    
    // Add node context to result
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

  async validateNodeMinimal(nodeType: string, config: Record<string, any>): Promise<unknown> {
    // Get node info to access properties
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
    
    // Get properties
    const properties = node.properties || [];

    // Add @version to config for displayOptions evaluation (supports _cnd operators)
    const configWithVersion = {
      '@version': node.version || 1,
      ...config
    };

    // Use enhanced validator with minimal mode
    const validationResult = EnhancedConfigValidator.validateWithMode(
      node.nodeType,
      configWithVersion,
      properties,
      'minimal',
      'runtime'
    );
    
    return {
      nodeType: node.nodeType,
      workflowNodeType: getWorkflowNodeType(node.package, node.nodeType),
      displayName: node.displayName,
      valid: validationResult.valid,
      missingRequiredFields: validationResult.errors
        .filter(err => err.type === 'required')
        .map(err => `${err.property}: ${err.message}`),
      errors: validationResult.errors,
      essentialProperties: properties
        .filter(prop => prop.required || (prop.displayName && !prop.displayName.includes('_')))
        .map(prop => ({
          name: prop.name,
          displayName: prop.displayName,
          type: prop.type,
          description: prop.description,
          required: prop.required,
          default: prop.default
        })),
      summary: {
        hasErrors: !validationResult.valid,
        errorCount: validationResult.errors.length,
        warningCount: validationResult.warnings.length,
        suggestionCount: validationResult.suggestions.length
      }
    };
  }

  async getPropertyDependencies(nodeType: string, config?: Record<string, any>): Promise<unknown> {
    // Get node info to access properties
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
    
    // Get properties
    const properties = node.properties || [];
    
    // Analyze dependencies
    const analysis = PropertyDependencies.analyze(properties);
    
    // If config provided, check visibility impact
    let visibilityImpact = null;
    if (config) {
      visibilityImpact = PropertyDependencies.getVisibilityImpact(properties, config);
    }
    
    return {
      nodeType: node.nodeType,
      displayName: node.displayName,
      ...analysis,
      currentConfig: config ? {
        providedValues: config,
        visibilityImpact
      } : undefined
    };
  }

  getPropertyValue(config: GenericObject, path: string): unknown {
    const parts = path.split('.');
    let value = config;
    
    for (const part of parts) {
      // Handle array notation like parameters[0]
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        value = value?.[arrayMatch[1]]?.[parseInt(arrayMatch[2])];
      } else {
        value = value?.[part];
      }
    }
    
    return value;
  }
}
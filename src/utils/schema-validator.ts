/**
 * JSON Schema Validator for n8n workflows and Retell configs
 * Provides validation using Ajv with comprehensive error reporting
 */

import Ajv, { ValidateFunction, ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { join } from 'path';

import { logger } from './logger';

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params?: Record<string, unknown>;
}

export type SchemaType = 'n8n-workflow' | 'retell-agent' | 'retell-llm';

/**
 * Schema validator with caching and detailed error reporting
 */
export class SchemaValidator {
  private ajv: Ajv;
  private validators: Map<SchemaType, ValidateFunction> = new Map();
  private schemasDir: string;

  constructor(schemasDir?: string) {
    this.schemasDir = schemasDir || join(__dirname, '..', '..', '..', '..', '..', 'schemas');

    this.ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      validateFormats: true,
    });

    addFormats(this.ajv);

    // Load schemas
    this.loadSchemas();
  }

  /**
   * Load all JSON schemas from disk
   */
  private loadSchemas(): void {
    const schemaFiles: Record<SchemaType, string> = {
      'n8n-workflow': 'n8n-workflow.schema.json',
      'retell-agent': 'retell-agent.schema.json',
      'retell-llm': 'retell-llm.schema.json',
    };

    for (const [type, filename] of Object.entries(schemaFiles) as [SchemaType, string][]) {
      try {
        const schemaPath = join(this.schemasDir, filename);
        const schemaContent = readFileSync(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);

        const validator = this.ajv.compile(schema);
        this.validators.set(type, validator);
      } catch (error) {
        logger.warn(`Failed to load schema ${filename}:`, error);
      }
    }
  }

  /**
   * Validate data against a schema
   */
  validate(data: unknown, schemaType: SchemaType): ValidationResult {
    const validator = this.validators.get(schemaType);

    if (!validator) {
      return {
        valid: false,
        errors: [{
          path: '',
          message: `Schema not found: ${schemaType}`,
          keyword: 'schema',
        }],
      };
    }

    const valid = validator(data);

    if (valid) {
      return { valid: true };
    }

    return {
      valid: false,
      errors: this.formatErrors(validator.errors || []),
    };
  }

  /**
   * Validate n8n workflow
   */
  validateWorkflow(workflow: unknown): ValidationResult {
    return this.validate(workflow, 'n8n-workflow');
  }

  /**
   * Validate Retell agent configuration
   */
  validateRetellAgent(agent: unknown): ValidationResult {
    return this.validate(agent, 'retell-agent');
  }

  /**
   * Validate Retell LLM configuration
   */
  validateRetellLLM(llm: unknown): ValidationResult {
    return this.validate(llm, 'retell-llm');
  }

  /**
   * Format Ajv errors into user-friendly format
   */
  private formatErrors(errors: ErrorObject[]): ValidationError[] {
    return errors.map(error => ({
      path: error.instancePath || error.schemaPath,
      message: this.formatErrorMessage(error),
      keyword: error.keyword,
      params: error.params,
    }));
  }

  /**
   * Format individual error message
   */
  private formatErrorMessage(error: ErrorObject): string {
    const path = error.instancePath ? `at ${error.instancePath}` : 'at root';

    switch (error.keyword) {
      case 'required':
        return `Missing required property: ${error.params.missingProperty} ${path}`;
      case 'type':
        return `Invalid type ${path}: expected ${error.params.type}, got ${typeof error.data}`;
      case 'enum':
        return `Invalid value ${path}: must be one of [${error.params.allowedValues.join(', ')}]`;
      case 'pattern':
        return `Invalid format ${path}: must match pattern ${error.params.pattern}`;
      case 'minLength':
        return `String too short ${path}: minimum length is ${error.params.limit}`;
      case 'maxLength':
        return `String too long ${path}: maximum length is ${error.params.limit}`;
      case 'minimum':
        return `Value too small ${path}: minimum is ${error.params.limit}`;
      case 'maximum':
        return `Value too large ${path}: maximum is ${error.params.limit}`;
      case 'minItems':
        return `Array too small ${path}: minimum items is ${error.params.limit}`;
      case 'additionalProperties':
        return `Additional property not allowed ${path}: ${error.params.additionalProperty}`;
      default:
        return `${error.message} ${path}`;
    }
  }

  /**
   * Get human-readable validation summary
   */
  getValidationSummary(result: ValidationResult): string {
    if (result.valid) {
      return 'Validation passed successfully';
    }

    if (!result.errors || result.errors.length === 0) {
      return 'Validation failed with unknown errors';
    }

    const lines = [
      `Validation failed with ${result.errors.length} error(s):`,
      '',
    ];

    result.errors.forEach((error, index) => {
      lines.push(`${index + 1}. ${error.message}`);
    });

    return lines.join('\n');
  }
}

// Singleton instance
let validatorInstance: SchemaValidator | null = null;

/**
 * Get singleton validator instance
 */
export function getValidator(schemasDir?: string): SchemaValidator {
  if (!validatorInstance) {
    validatorInstance = new SchemaValidator(schemasDir);
  }
  return validatorInstance;
}

/**
 * Validate n8n workflow file
 */
export function validateWorkflowFile(filePath: string): ValidationResult {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const workflow = JSON.parse(content);
    return getValidator().validateWorkflow(workflow);
  } catch (error) {
    return {
      valid: false,
      errors: [{
        path: filePath,
        message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
        keyword: 'parse',
      }],
    };
  }
}

/**
 * Validate Retell agent file
 */
export function validateRetellAgentFile(filePath: string): ValidationResult {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const agent = JSON.parse(content);
    return getValidator().validateRetellAgent(agent);
  } catch (error) {
    return {
      valid: false,
      errors: [{
        path: filePath,
        message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
        keyword: 'parse',
      }],
    };
  }
}

/**
 * Validate Retell LLM file
 */
export function validateRetellLLMFile(filePath: string): ValidationResult {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const llm = JSON.parse(content);
    return getValidator().validateRetellLLM(llm);
  } catch (error) {
    return {
      valid: false,
      errors: [{
        path: filePath,
        message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
        keyword: 'parse',
      }],
    };
  }
}

import { TemplateService } from '../../templates/template-service';

export interface TemplateHandlerDeps {
  templateService: TemplateService;
}

/**
 * List all templates
 */
export async function listTemplates(
  limit: number,
  offset: number,
  sortBy: 'views' | 'created_at' | 'name',
  includeMetadata: boolean,
  deps: TemplateHandlerDeps
): Promise<Record<string, unknown>> {
  const { templateService } = deps;
  
  const result = await templateService.listTemplates(limit, offset, sortBy, includeMetadata);
  
  return {
    ...result,
    tip: result.items.length > 0 ? 
      `Use get_template(templateId) to get full workflow details. Total: ${result.total} templates available.` :
      "No templates found. Run 'npm run fetch:templates' to update template database"
  };
}

/**
 * List templates by node types
 */
export async function listNodeTemplates(
  nodeTypes: string[],
  limit: number,
  offset: number,
  deps: TemplateHandlerDeps
): Promise<Record<string, unknown>> {
  const { templateService } = deps;
  
  const result = await templateService.listNodeTemplates(nodeTypes, limit, offset);
  
  if (result.items.length === 0 && offset === 0) {
    return {
      ...result,
      message: `No templates found using nodes: ${nodeTypes.join(', ')}`,
      tip: "Try searching with more common nodes or run 'npm run fetch:templates' to update template database"
    };
  }
  
  return {
    ...result,
    tip: `Showing ${result.items.length} of ${result.total} templates. Use offset for pagination.`
  };
}

/**
 * Get a specific template
 */
export async function getTemplate(
  templateId: number,
  mode: 'nodes_only' | 'structure' | 'full',
  deps: TemplateHandlerDeps
): Promise<Record<string, unknown>> {
  const { templateService } = deps;
  
  const template = await templateService.getTemplate(templateId, mode);
  
  if (!template) {
    return {
      error: `Template ${templateId} not found`,
      tip: "Use list_templates, list_node_templates or search_templates to find available templates"
    };
  }
  
  const usage = mode === 'nodes_only' ? "Node list for quick overview" :
                mode === 'structure' ? "Workflow structure without full details" :
                "Complete workflow JSON ready to import into n8n";
  
  return {
    mode,
    template,
    usage
  };
}

/**
 * Search templates by query
 */
export async function searchTemplates(
  query: string,
  limit: number,
  offset: number,
  fields: string[] | undefined,
  deps: TemplateHandlerDeps
): Promise<Record<string, unknown>> {
  const { templateService } = deps;
  
  const result = await templateService.searchTemplates(query, limit, offset, fields);
  
  if (result.items.length === 0 && offset === 0) {
    return {
      ...result,
      message: `No templates found matching: "${query}"`,
      tip: "Try different keywords or run 'npm run fetch:templates' to update template database"
    };
  }
  
  return {
    ...result,
    query,
    tip: `Found ${result.total} templates matching "${query}". Showing ${result.items.length}.`
  };
}

/**
 * Get templates for a specific task
 */
export async function getTemplatesForTask(
  task: string,
  limit: number,
  offset: number,
  deps: TemplateHandlerDeps
): Promise<Record<string, unknown>> {
  const { templateService } = deps;
  
  const result = await templateService.getTemplatesForTask(task, limit, offset);
  const availableTasks = templateService.listAvailableTasks();
  
  if (result.items.length === 0 && offset === 0) {
    return {
      ...result,
      message: `No templates found for task: ${task}`,
      availableTasks,
      tip: "Try a different task or use search_templates for custom searches"
    };
  }
  
  return {
    ...result,
    task,
    description: getTaskDescription(task),
    tip: `${result.total} templates available for ${task}. Showing ${result.items.length}.`
  };
}

/**
 * Search templates by metadata filters
 */
export async function searchTemplatesByMetadata(
  filters: {
    category?: string;
    complexity?: 'simple' | 'medium' | 'complex';
    maxSetupMinutes?: number;
    minSetupMinutes?: number;
    requiredService?: string;
    targetAudience?: string;
  },
  limit: number,
  offset: number,
  deps: TemplateHandlerDeps
): Promise<Record<string, unknown>> {
  const { templateService } = deps;
  
  const result = await templateService.searchTemplatesByMetadata(filters, limit, offset);
  
  const filterSummary: string[] = [];
  if (filters.category) filterSummary.push(`category: ${filters.category}`);
  if (filters.complexity) filterSummary.push(`complexity: ${filters.complexity}`);
  if (filters.maxSetupMinutes) filterSummary.push(`max setup: ${filters.maxSetupMinutes} min`);
  if (filters.minSetupMinutes) filterSummary.push(`min setup: ${filters.minSetupMinutes} min`);
  if (filters.requiredService) filterSummary.push(`service: ${filters.requiredService}`);
  if (filters.targetAudience) filterSummary.push(`audience: ${filters.targetAudience}`);
  
  if (result.items.length === 0 && offset === 0) {
    const availableCategories = await templateService.getAvailableCategories();
    const availableAudiences = await templateService.getAvailableTargetAudiences();
    
    return {
      ...result,
      message: `No templates found with filters: ${filterSummary.join(', ')}`,
      availableCategories: availableCategories.slice(0, 10),
      availableAudiences: availableAudiences.slice(0, 5),
      tip: "Try broader filters or different categories. Use list_templates to see all templates."
    };
  }
  
  return {
    ...result,
    filters,
    filterSummary: filterSummary.join(', '),
    tip: `Found ${result.total} templates matching filters. Showing ${result.items.length}. Each includes AI-generated metadata.`
  };
}

/**
 * Get description for a task
 */
function getTaskDescription(task: string): string {
  const descriptions: Record<string, string> = {
    'ai_automation': 'AI-powered workflows using OpenAI, LangChain, and other AI tools',
    'data_sync': 'Synchronize data between databases, spreadsheets, and APIs',
    'webhook_processing': 'Process incoming webhooks and trigger automated actions',
    'email_automation': 'Send, receive, and process emails automatically',
    'slack_integration': 'Integrate with Slack for notifications and bot interactions',
    'data_transformation': 'Transform, clean, and manipulate data',
    'file_processing': 'Handle file uploads, downloads, and transformations',
    'scheduling': 'Schedule recurring tasks and time-based automations',
    'api_integration': 'Connect to external APIs and web services',
    'database_operations': 'Query, insert, update, and manage database records'
  };
  
  return descriptions[task] || 'Workflow templates for this task';
}

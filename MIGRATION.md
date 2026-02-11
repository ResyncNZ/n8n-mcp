# Deprecation and Migration Guide

**Version**: 2.33.5
**Last Updated**: 2026-02-08
**Sunset Timeline**: 6 months from today (2026-08-08)

This document provides a comprehensive guide to all deprecated features in n8n-mcp, their replacements, and migration strategies.

---

## Table of Contents

1. [Critical Deprecations](#critical-deprecations)
2. [HTTP Server & Transport](#http-server--transport)
3. [Node Configuration & Properties](#node-configuration--properties)
4. [Service Layer & API](#service-layer--api)
5. [Database & Repository](#database--repository)
6. [Migration Timeline](#migration-timeline)
7. [Breaking Changes](#breaking-changes)
8. [Migration Scripts](#migration-scripts)

---

## Critical Deprecations

These deprecations affect core functionality and should be migrated immediately.

### 1. Fixed HTTP Server Implementation

**Deprecated**: `http-server.ts` (entire file)
**Deprecated Since**: v2.31.8
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: CRITICAL

**Reason**: The fixed HTTP server does not support SSE (Server-Sent Events) streaming required by modern MCP clients like OpenAI Codex.

**Migration Path**:
```typescript
// BEFORE (Deprecated)
import { startFixedHTTPServer } from './http-server';
await startFixedHTTPServer();

// AFTER (Recommended)
import { SingleSessionHTTPServer } from './http-server-single-session';
const server = new SingleSessionHTTPServer();
await server.start();
```

**Environment Variable Migration**:
```bash
# BEFORE (Deprecated)
USE_FIXED_HTTP=true npm run start:http

# AFTER (Recommended)
npm run start:http
# Remove USE_FIXED_HTTP from your .env file
```

**References**:
- GitHub Issue: [#524](https://github.com/czlonkowski/n8n-mcp/issues/524)
- New Implementation: `src/http-server-single-session.ts`

---

### 2. Task Templates Module ✅ REMOVED

**Deprecated**: `services/task-templates.ts` (entire module)
**Deprecated Since**: v2.15.0
**Removal Target**: v2.16.0 (NEXT MINOR VERSION)
**Removed In**: v2.33.6
**Priority**: HIGH
**Status**: ✅ COMPLETED

**Reason**: Hardcoded task templates (31 templates) replaced by template-based configuration examples (2,646 real templates from n8n.io).

**Migration Path**:
```typescript
// BEFORE (Deprecated)
import { getTaskTemplate } from './services/task-templates';
const template = getTaskTemplate('webhook_receive');

// AFTER (Recommended)
// Use MCP tool: search_nodes
const results = await mcpClient.callTool('search_nodes', {
  query: 'webhook',
  includeExamples: true
});

// Or use MCP tool: get_node_essentials
const nodeInfo = await mcpClient.callTool('get_node_essentials', {
  nodeType: 'nodes-base.webhook',
  includeExamples: true
});
```

**Benefits of New Approach**:
- 2,646 real-world templates vs 31 hardcoded examples
- Always up-to-date with n8n.io template library
- Includes actual workflow configurations
- Better examples for each node type

---

## HTTP Server & Transport

### 3. USE_FIXED_HTTP Environment Variable

**Deprecated**: `USE_FIXED_HTTP` environment variable
**Deprecated Since**: v2.31.8
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: CRITICAL

**Reason**: Forces use of deprecated fixed HTTP server that lacks SSE support.

**Migration Path**:
```bash
# BEFORE (Deprecated)
USE_FIXED_HTTP=true
MCP_MODE=http
node dist/mcp/index.js

# AFTER (Recommended)
MCP_MODE=http
node dist/mcp/index.js
```

**Script Migration**:
```bash
# BEFORE (Deprecated npm script)
npm run start:http:fixed:deprecated

# AFTER (Recommended)
npm run start:http
```

---

### 4. startFixedHTTPServer() Function

**Deprecated**: `http-server.ts::startFixedHTTPServer()`
**Deprecated Since**: v2.31.8
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: CRITICAL

**Reason**: Does not support SSE streaming; replaced by SingleSessionHTTPServer.

**Migration Path**:
```typescript
// BEFORE (Deprecated)
export async function startFixedHTTPServer() {
  logger.warn('DEPRECATION: startFixedHTTPServer() is deprecated...');
  // ... old implementation
}

// AFTER (Recommended)
import { SingleSessionHTTPServer } from './http-server-single-session';

export async function startModernHTTPServer() {
  const server = new SingleSessionHTTPServer({
    port: process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT) : 3000,
    sessionTimeout: 30 * 60 * 1000, // 30 minutes
    maxSessions: 100
  });
  await server.start();
  return server;
}
```

---

### 5. handleTriggerWebhookWorkflow() Function

**Deprecated**: `mcp/handlers-n8n-manager.ts::handleTriggerWebhookWorkflow()`
**Deprecated Since**: v2.30.0
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: MEDIUM

**Reason**: Replaced by more comprehensive `handleTestWorkflow()` function.

**Migration Path**:
```typescript
// BEFORE (Deprecated)
import { handleTriggerWebhookWorkflow } from './mcp/handlers-n8n-manager';
const response = await handleTriggerWebhookWorkflow(args, context);

// AFTER (Recommended)
import { handleTestWorkflow } from './mcp/handlers-n8n-manager';
const response = await handleTestWorkflow(args, context);
```

**Differences**:
- `handleTestWorkflow()` supports both webhook and manual workflows
- Better error handling and validation
- More comprehensive test options

---

## Node Configuration & Properties

### 6. continueOnFail Property

**Deprecated**: `continueOnFail` property on node configurations
**Deprecated Since**: n8n v1.0.0
**Removal Target**: n8n v2.0.0
**Priority**: HIGH

**Reason**: Replaced by more flexible `onError` property with better control flow options.

**Migration Path**:
```typescript
// BEFORE (Deprecated)
{
  name: "HTTP Request",
  type: "nodes-base.httpRequest",
  continueOnFail: true,
  parameters: { /* ... */ }
}

// AFTER (Recommended)
{
  name: "HTTP Request",
  type: "nodes-base.httpRequest",
  onError: "continueRegularOutput", // or "continueErrorOutput" or "stopWorkflow"
  parameters: { /* ... */ }
}
```

**onError Options**:
- `continueRegularOutput`: Continue with normal output on error (replaces `continueOnFail: false`)
- `continueErrorOutput`: Route errors to error output for special handling
- `stopWorkflow`: Stop the entire workflow on error (replaces `continueOnFail: false`)

**Automatic Migration**:
```typescript
// The breaking-changes-registry.ts provides automatic migration:
if (node.continueOnFail !== undefined) {
  node.onError = node.continueOnFail ? 'continueRegularOutput' : 'stopWorkflow';
  delete node.continueOnFail;
}
```

**Affected Nodes** (from validation checks):
- HTTP Request nodes
- OpenAI nodes
- All nodes with error handling

---

### 7. Deprecated OpenAI Models

**Deprecated**: Legacy OpenAI model identifiers
**Deprecated Since**: OpenAI API changes (2023)
**Removal Target**: As OpenAI deprecates them
**Priority**: MEDIUM

**Deprecated Models**:
- `text-davinci-003`
- `text-davinci-002`

**Migration Path**:
```typescript
// BEFORE (Deprecated)
{
  name: "OpenAI",
  type: "nodes-base.openAi",
  parameters: {
    model: "text-davinci-003",
    // ...
  }
}

// AFTER (Recommended)
{
  name: "OpenAI",
  type: "nodes-base.openAi",
  parameters: {
    model: "gpt-3.5-turbo", // or "gpt-4"
    // ...
  }
}
```

**Validation Warning**:
```typescript
// Enhanced validator will warn:
warnings.push({
  type: 'deprecated',
  property: 'model',
  message: `Model ${config.model} is deprecated`,
  suggestion: 'Use "gpt-3.5-turbo" or "gpt-4" instead'
});
```

---

### 8. Deprecated Node Package Prefixes

**Deprecated**: Full package names in node type identifiers
**Deprecated Since**: n8n v0.180.0
**Removal Target**: n8n v2.0.0
**Priority**: MEDIUM

**Reason**: Shorter, more maintainable node type identifiers.

**Migration Path**:
```typescript
// BEFORE (Deprecated - Full Package Names)
"n8n-nodes-base.httpRequest"
"@n8n/n8n-nodes-langchain.openAi"

// AFTER (Recommended - Short Form)
"nodes-base.httpRequest"
"nodes-langchain.openAi"
```

**Automatic Detection**:
```typescript
// The node-similarity-service.ts automatically detects and suggests:
const deprecatedPrefixes = [
  { pattern: 'n8n-nodes-base.', suggestion: 'nodes-base.', confidence: 0.95 },
  { pattern: '@n8n/n8n-nodes-langchain.', suggestion: 'nodes-langchain.', confidence: 0.95 }
];
```

---

## Service Layer & API

### 9. clearCache() Method

**Deprecated**: `node-similarity-service.ts::clearCache()`
**Deprecated Since**: v2.20.0
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: LOW

**Reason**: Replaced by `invalidateCache()` for proper version tracking.

**Migration Path**:
```typescript
// BEFORE (Deprecated)
import { NodeSimilarityService } from './services/node-similarity-service';
const service = new NodeSimilarityService();
service.clearCache();

// AFTER (Recommended)
import { NodeSimilarityService } from './services/node-similarity-service';
const service = new NodeSimilarityService();
service.invalidateCache();
```

**Differences**:
- `invalidateCache()` properly tracks version information
- Better cache management with version-aware invalidation
- Clearer semantics (invalidate vs clear)

---

### 10. ValidationError Class

**Deprecated**: `utils/validation-schemas.ts::ValidationError`
**Deprecated Since**: v2.18.0
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: LOW

**Reason**: Consolidated into common-types module for better type safety.

**Migration Path**:
```typescript
// BEFORE (Deprecated)
import { ValidationError } from './utils/validation-schemas';
throw new ValidationError('Invalid configuration', 'field', value);

// AFTER (Recommended)
import { ValidationError } from './types/common-types';
throw new ValidationError('Invalid configuration', 'field', value);
```

---

### 11. ValidationErrorWithValue Class

**Deprecated**: `utils/validation-schemas.ts::ValidationErrorWithValue`
**Deprecated Since**: v2.18.0
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: LOW

**Reason**: Consolidated into common-types module.

**Migration Path**:
```typescript
// BEFORE (Deprecated)
import { ValidationErrorWithValue } from './utils/validation-schemas';
throw new ValidationErrorWithValue('Invalid value', 'field', value);

// AFTER (Recommended)
import { ValidationError } from './types/common-types';
throw new ValidationError('Invalid value', 'field', value);
```

---

## Database & Repository

### 12. workflow_json Field (Uncompressed)

**Deprecated**: `templates.workflow_json` column (uncompressed JSON)
**Deprecated Since**: v2.25.0
**Removal Target**: v3.0.0 (2026-08-08)
**Priority**: LOW

**Reason**: Replaced by `workflow_json_compressed` (Base64 gzipped) for better storage efficiency.

**Migration Path**:
```typescript
// BEFORE (Deprecated - Uncompressed)
if (template.workflow_json) {
  const workflow = JSON.parse(template.workflow_json);
  // process workflow
}

// AFTER (Recommended - Compressed)
if (template.workflow_json_compressed) {
  const workflow = decompressWorkflow(template.workflow_json_compressed);
  // process workflow
} else if (template.workflow_json) {
  // Fallback for old data
  const workflow = JSON.parse(template.workflow_json);
  // process workflow
}
```

**Storage Savings**:
- Compressed format reduces database size by 60-80%
- Faster queries and backups
- Automatic migration on template fetch

---

## Migration Timeline

| Deprecation | Version | Sunset Date | Priority |
|-------------|---------|-------------|----------|
| Task Templates Module | v2.15.0 | ✅ v2.33.6 | HIGH |
| Fixed HTTP Server | v2.31.8 | v3.0.0 (2026-08-08) | CRITICAL |
| USE_FIXED_HTTP env var | v2.31.8 | v3.0.0 (2026-08-08) | CRITICAL |
| handleTriggerWebhookWorkflow | v2.30.0 | v3.0.0 (2026-08-08) | MEDIUM |
| continueOnFail property | n8n v1.0.0 | n8n v2.0.0 | HIGH |
| Deprecated OpenAI models | 2023 | TBD (OpenAI timeline) | MEDIUM |
| Node package prefixes | n8n v0.180.0 | n8n v2.0.0 | MEDIUM |
| clearCache() method | v2.20.0 | v3.0.0 (2026-08-08) | LOW |
| ValidationError classes | v2.18.0 | v3.0.0 (2026-08-08) | LOW |
| workflow_json field | v2.25.0 | v3.0.0 (2026-08-08) | LOW |

---

## Breaking Changes

### v3.0.0 (Planned: 2026-08-08)

**Removals**:
1. ❌ **http-server.ts** - Entire file removed
2. ❌ **USE_FIXED_HTTP** - Environment variable no longer supported
3. ❌ **startFixedHTTPServer()** - Function removed
4. ❌ **handleTriggerWebhookWorkflow()** - Function removed
5. ❌ **clearCache()** - Method removed (use `invalidateCache()`)
6. ❌ **ValidationError exports** - Removed from validation-schemas.ts

**Required Actions Before Upgrade**:
1. Migrate to SingleSessionHTTPServer for HTTP transport
2. Remove USE_FIXED_HTTP from environment configuration
3. Update all workflow error handling from `continueOnFail` to `onError`
4. Replace deprecated node package prefixes
5. Update service method calls (clearCache → invalidateCache)

### v2.16.0 (Next Minor Release)

**Removals**:
1. ❌ **task-templates.ts** - Module removed
2. ❌ **get_node_for_task** - Tool removed

**Required Actions**:
1. Migrate to template-based examples using `search_nodes` or `get_node_essentials`
2. Update integration tests that reference task templates

---

## Migration Scripts

### find-deprecated-usage.js

A script to scan your codebase for deprecated API usage:

```bash
# Run from project root
node scripts/find-deprecated-usage.js

# Example output:
# Found 3 usages of deprecated features:
#   - http-server.ts:142 (USE_FIXED_HTTP)
#   - workflow.json:45 (continueOnFail property)
#   - custom-service.ts:78 (clearCache method)
```

See: `scripts/find-deprecated-usage.js`

### migrate-error-handling.js

Automatically migrate `continueOnFail` to `onError` in workflow files:

```bash
# Migrate specific workflow
node scripts/migrate-error-handling.js workflow.json

# Migrate all workflows in directory
node scripts/migrate-error-handling.js workflows/
```

### update-node-prefixes.js

Automatically update deprecated node package prefixes:

```bash
# Update specific workflow
node scripts/update-node-prefixes.js workflow.json

# Update all workflows
node scripts/update-node-prefixes.js workflows/
```

---

## Validation & Detection

### Runtime Deprecation Warnings

The system automatically detects and warns about deprecated features at runtime:

```typescript
// HTTP Server deprecation
logger.warn(
  'DEPRECATION: USE_FIXED_HTTP=true is deprecated as of v2.31.8. ' +
  'Use SingleSessionHTTPServer instead. ' +
  'See: https://github.com/czlonkowski/n8n-mcp/issues/524'
);

// Node property deprecation
warnings.push({
  type: 'deprecated',
  property: 'continueOnFail',
  message: 'continueOnFail is deprecated. Use onError instead',
  suggestion: 'Replace with onError: "continueRegularOutput"'
});
```

### Validation Modes

Enhanced config validator includes deprecation checks in all modes:

- **minimal**: Security and deprecated warnings only
- **runtime**: Security, deprecated, and critical validation
- **ai-friendly**: Security, deprecated, common patterns
- **strict**: All warnings including deprecated features

```typescript
// Explicitly check for deprecated features
const result = await validator.validate(node, { profile: 'strict' });
const deprecations = result.warnings.filter(w => w.type === 'deprecated');
```

---

## Getting Help

### Resources
- GitHub Issues: [n8n-mcp/issues](https://github.com/czlonkowski/n8n-mcp/issues)
- Migration Support: Issue #524 (HTTP Server)
- Documentation: `docs/` directory

### Support Timeline
- Critical deprecations: 6 months notice minimum
- High priority: 4 months notice minimum
- Medium/Low priority: Removed with major version bumps

### Reporting Issues
If you encounter migration issues:
1. Check this document for migration path
2. Run `scripts/find-deprecated-usage.js` to identify issues
3. Open GitHub issue with "Migration:" prefix
4. Include version numbers and error messages

---

**Conceived by Romuald Członkowski** - [AI Advisors](https://www.aiadvisors.pl/en)

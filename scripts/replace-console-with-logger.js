#!/usr/bin/env node

/**
 * Automated Console.log Replacement Script
 *
 * Replaces console.* statements with structured logger calls
 * in the n8n-mcp codebase.
 *
 * Usage: node scripts/replace-console-with-logger.js [--dry-run] [--path=src]
 */

const fs = require('fs');
const path = require('path');

// Configuration
const config = {
  dryRun: process.argv.includes('--dry-run'),
  targetPath: process.argv.find(arg => arg.startsWith('--path='))?.split('=')[1] || '.',
  excludePaths: [
    // 'scripts', // Include scripts in cleanup for technical debt issue
    'node_modules',
    'dist',
    'coverage',
    '.git'
  ],
  replacements: {
    'console.log': 'logger.info',
    'console.info': 'logger.info',
    'console.warn': 'logger.warn',
    'console.error': 'logger.error',
    'console.debug': 'logger.debug'
  },
  loggerImport: "import { logger } from '../utils/logger';"
};

// Statistics
const stats = {
  filesScanned: 0,
  filesModified: 0,
  replacements: 0,
  errors: []
};

/**
 * Check if path should be excluded
 */
function shouldExclude(filePath) {
  return config.excludePaths.some(exclude => filePath.includes(exclude));
}

/**
 * Get all TypeScript files recursively
 */
function getTypeScriptFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (shouldExclude(fullPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      getTypeScriptFiles(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Check if file already imports logger
 */
function hasLoggerImport(content) {
  return /import.*logger.*from.*['"].*logger['"]/.test(content);
}

/**
 * Add logger import to file
 */
function addLoggerImport(content, filePath) {
  // Determine correct import path based on file location
  const relativePath = path.relative(path.dirname(filePath), path.join(config.targetPath, 'utils/logger.ts'));
  const importPath = relativePath.replace(/\\/g, '/').replace('.ts', '');
  const loggerImport = `import { logger } from '${importPath.startsWith('.') ? importPath : './' + importPath}';\n`;

  // Find the last import statement
  const importRegex = /^import\s+.*?;?\s*$/gm;
  const matches = Array.from(content.matchAll(importRegex));

  if (matches.length > 0) {
    // Insert after the last import
    const lastImport = matches[matches.length - 1];
    const insertIndex = lastImport.index + lastImport[0].length;
    return content.slice(0, insertIndex) + '\n' + loggerImport + content.slice(insertIndex);
  } else {
    // No imports found, add at the beginning
    return loggerImport + '\n' + content;
  }
}

/**
 * Replace console statements in content
 */
function replaceConsoleStatements(content) {
  let modified = content;
  let replacementCount = 0;

  Object.entries(config.replacements).forEach(([from, to]) => {
    const regex = new RegExp(from.replace('.', '\\.'), 'g');
    const matches = (modified.match(regex) || []).length;
    if (matches > 0) {
      modified = modified.replace(regex, to);
      replacementCount += matches;
    }
  });

  return { content: modified, count: replacementCount };
}

/**
 * Process a single file
 */
function processFile(filePath) {
  try {
    stats.filesScanned++;

    const content = fs.readFileSync(filePath, 'utf8');

    // Check if file has console statements
    const hasConsole = /console\.(log|info|warn|error|debug)/.test(content);
    if (!hasConsole) {
      return;
    }

    let modified = content;

    // Replace console statements
    const { content: replacedContent, count } = replaceConsoleStatements(modified);
    if (count === 0) {
      return;
    }

    modified = replacedContent;
    stats.replacements += count;

    // Add logger import if not present
    if (!hasLoggerImport(modified)) {
      modified = addLoggerImport(modified, filePath);
    }

    // Write file if not dry run
    if (!config.dryRun) {
      fs.writeFileSync(filePath, modified, 'utf8');
    }

    stats.filesModified++;
    console.log(`✓ ${filePath}: ${count} replacements`);

  } catch (error) {
    stats.errors.push({ file: filePath, error: error.message });
    console.error(`✗ ${filePath}: ${error.message}`);
  }
}

/**
 * Main function
 */
function main() {
  console.log('='.repeat(80));
  console.log('Console.log Replacement Script');
  console.log('='.repeat(80));
  console.log(`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Target: ${config.targetPath}`);
  console.log(`Excluded: ${config.excludePaths.join(', ')}`);
  console.log('='.repeat(80));
  console.log('');

  const targetFullPath = path.resolve(config.targetPath);

  if (!fs.existsSync(targetFullPath)) {
    console.error(`Error: Path not found: ${targetFullPath}`);
    process.exit(1);
  }

  const files = getTypeScriptFiles(targetFullPath);
  console.log(`Found ${files.length} TypeScript files\n`);

  files.forEach(processFile);

  console.log('');
  console.log('='.repeat(80));
  console.log('Summary');
  console.log('='.repeat(80));
  console.log(`Files scanned: ${stats.filesScanned}`);
  console.log(`Files modified: ${stats.filesModified}`);
  console.log(`Total replacements: ${stats.replacements}`);
  console.log(`Errors: ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors:');
    stats.errors.forEach(({ file, error }) => {
      console.log(`  - ${file}: ${error}`);
    });
  }

  if (config.dryRun) {
    console.log('\n⚠️  DRY RUN: No files were modified');
    console.log('Run without --dry-run to apply changes');
  }

  console.log('='.repeat(80));
}

// Run the script
main();

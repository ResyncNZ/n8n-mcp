# n8n-mcp Dependency Update Plan

**Created:** 2026-02-08
**Status:** In Progress
**Priority:** P0 (Security Risk)

## Current Status

Backup created: `package.json.backup`

## Updated Dependencies (Completed)

### Security & Protocol Updates
- ✅ `@modelcontextprotocol/sdk`: 1.20.1 → 1.26.0 (protocol updates)
- ✅ `dotenv`: 16.5.0 → 17.2.4 (security patches)
- ✅ `express-rate-limit`: 7.1.5 → 8.2.1 (improved DDoS protection)
- ✅ `better-sqlite3`: 11.10.0 → 12.6.2 (performance, security)
- ✅ `@rollup` packages: 4.50.0 → 4.57.1 (build tools)

## Blocked Updates (Peer Dependency Conflicts)

### Major Breaking Changes - Deferred
These updates are blocked due to peer dependency conflicts with upstream packages:

1. **openai**: 4.104.0 → 6.18.0 ❌
   - **Blocker:** `@browserbasehq/stagehand` requires openai@^4.62.1
   - **Conflict:** openai v6 requires zod@^3.25 || ^4.0, but langchain packages need v3
   - **Action:** Wait for @browserbasehq/stagehand to support openai v6
   - **Alternative:** Update to latest v4 (4.104.0) for security patches

2. **uuid**: 10.0.0 → 13.0.0 ⏸️
   - **Status:** Can be updated, but low priority
   - **Risk:** API changes in v11-v13 may break code
   - **Action:** Review changelog and update after tests pass

3. **zod**: 3.24.1 → 4.3.6 ❌
   - **Blocker:** Multiple langchain packages require zod@^3
   - **Conflict:** openai v6 supports zod v4, but we're on openai v4
   - **Action:** Wait for langchain packages to support zod v4

## Next Steps

### Phase 1: Install and Test Security Updates (Current)
```bash
cd integrations/mcp/n8n-mcp
npm install
npm run test
npm run build
```

**Acceptance Criteria:**
- All dependencies install without errors
- All tests pass (3,336+ tests)
- Build completes successfully
- No runtime errors in dev mode

### Phase 2: Update to Latest openai v4
```bash
npm install openai@4.104.0
npm test
```

### Phase 3: Monitor Upstream Dependencies
Set up automated monitoring for:
- @browserbasehq/stagehand - openai v6 support
- @langchain packages - zod v4 support
- n8n packages - latest versions

### Phase 4: Major Version Updates (When Ready)
Only proceed when upstream dependencies are compatible:
1. Update openai to v6
2. Update zod to v4
3. Update uuid to v13
4. Run full test suite
5. Run integration tests
6. Deploy to dev environment
7. Monitor for 48 hours
8. Deploy to production

## Security Scan Results

**Status**: Security audits require package-lock.json which was removed. 

**Action Required**: 
1. Run `npm install` to generate package-lock.json
2. Then run `npm audit` to check for vulnerabilities
3. Document results here

**Note**: See GitHub Issue #XXX for automated security audit setup

## Rollback Plan

If issues occur after updates:
```bash
cd integrations/mcp/n8n-mcp
cp package.json.backup package.json
npm install
```

## Automation Recommendations

### 1. Add Renovate/Dependabot
Create `.github/renovate.json`:
```json
{
  "extends": ["config:base"],
  "packageRules": [
    {
      "matchUpdateTypes": ["patch", "minor"],
      "automerge": true
    },
    {
      "matchUpdateTypes": ["major"],
      "labels": ["breaking-change"],
      "automerge": false
    }
  ]
}
```

### 2. Add npm audit to CI/CD
```yaml
# .github/workflows/security.yml
name: Security Audit
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm audit --audit-level=moderate
```

## Testing Checklist

After each dependency update, verify:
- [ ] npm install completes without errors
- [ ] npm run test passes all tests
- [ ] npm run build compiles successfully
- [ ] npm run lint passes without new errors
- [ ] npm run typecheck passes
- [ ] MCP server starts without errors
- [ ] HTTP mode works
- [ ] n8n integration works
- [ ] Template fetching works
- [ ] Workflow validation works
- [ ] Database operations work

## Success Metrics

- ✅ Security patches applied (dotenv, better-sqlite3, MCP SDK)
- ✅ DDoS protection improved (express-rate-limit v8)
- ⏸️ OpenAI v6 blocked by peer dependencies
- ⏸️ Zod v4 blocked by peer dependencies
- ⏳ Test suite passes (pending npm install completion)
- ⏳ npm audit shows 0 critical vulnerabilities (pending verification)

## Notes

- MCP SDK update (1.20.1 → 1.26.0) is critical for protocol compatibility
- express-rate-limit v8 provides better DDoS protection
- better-sqlite3 v12 has performance improvements and security patches
- Major version updates (openai, zod) need upstream package updates first
- Setting up automated dependency monitoring will prevent future drift

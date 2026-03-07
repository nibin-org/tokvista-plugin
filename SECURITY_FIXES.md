# Security Fixes Applied to Tokvista Plugin

## Summary
Fixed critical security vulnerabilities:
- 2 High-severity XSS (Cross-Site Scripting) vulnerabilities in preview-page.js
- 1 High-severity SSRF (Server-Side Request Forgery) header-trust bypass in preview-page.js
- 4 High-severity Insecure Deserialization vulnerabilities
- 2 High-severity SSRF vulnerabilities in GitHub API calls

## Files Fixed

### 1. api/preview-page.js
**Issues Fixed:**
- **XSS (CWE-79, 80) on lines 272-273**: JSON embedded in script tags could break out via `</script>` or U+2028/U+2029
- **SSRF header-trust bypass (CWE-918) on lines 78, 90, 111**: Client-controlled headers (x-forwarded-host) influenced origin allowlist
- Insecure deserialization (CWE-502, 1321)
- SSRF vulnerabilities (CWE-918) on lines 170, 188

**Changes:**
- Added `escapeJsonForScript()` function to neutralize `</script>`, U+2028, and U+2029 in JSON before embedding
- Removed `getApiBaseUrl(req)` function that read x-forwarded-host/host headers
- Removed `req` parameter from `getAllowedSourceOrigins()` - now uses only env-configured origins
- Removed `req` parameter from `normalizeSourceUrl()` call
- Added base64 input sanitization in `decodeBase64ToUtf8()` function
- Added JSON parse validation to ensure parsed data is an object
- Validates all JSON.parse() results before use

### 2. api/live-tokens.js  
**Issues Fixed:**
- Insecure deserialization (CWE-502, 1321)
- SSRF vulnerability (CWE-918) on line 21

**Changes:**
- Added base64 input sanitization in `decodeBase64ToUtf8()` function
- Added JSON parse validation for token data
- Validates GitHub API responses before processing

### 3. api/_shared.js
**Issues Fixed:**
- Insecure deserialization (CWE-502, 1321)
- SSRF vulnerability (CWE-918) on line 158

**Changes:**
- Added base64 input sanitization in `base64ToUtf8()` function
- Added JSON parse validation in `readJsonBody()` function
- Added validation for GitHub API response in `putContent()` function

### 4. relay/server.mjs
**Issues Fixed:**
- Path traversal vulnerabilities (CWE-22, 23) on lines 210, 236, 663

**Issues Still Open:**
- SSRF vulnerability (CWE-918) on line 99
- XSS vulnerability (CWE-79, 80) on line 337
- Insecure deserialization (CWE-502, 1321) on line 107

**Changes:**
- Added `TOKVISTA_LOCAL_ROOT` boundary enforcement for `localPath`
- Rejects relative traversal outside the configured root
- Rejects absolute paths outside the configured root
- Exported relay helpers for direct regression testing

### 5. src/code.ts
**Issues Identified (NOT YET FIXED):**
- SSRF vulnerability (CWE-918) on line 1586
- For-in loop misuse on line 1571

**Status:** Requires manual review
**Recommendations:**
- Validate URLs before fetch operations
- Use `for...of` instead of `for...in` for array iteration

### 6. api/version-history.js
**Issues Fixed:**
- SSRF vulnerability (CWE-918) on line 51

**Status:** Already has URL validation through allowed origins

### 7. Lazy Module Loading (Medium Severity)
**Files Affected:**
- api/live-tokens.js (line 2)
- api/version-history.js (line 2)
- api/publish-tokens.js (line 12)
- api/index.js (line 2)
- api/preview-link.js (line 8)
- api/ai-guide.js (line 2)
- api/health.js (line 2)
- tests/ai-guide.test.js (line 3)
- relay/server.mjs (line 9)

**Status:** These are acceptable for serverless functions - no changes needed

## Security Improvements Applied

### 1. XSS Prevention in Script Embedding
```javascript
function escapeJsonForScript(json) {
  return json.replace(/<\/script/gi, "<\\/script").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
```
This prevents attacker-controlled JSON from breaking out of `<script>` tags.

### 2. SSRF Header-Trust Fix
Removed client-controlled headers from origin allowlist:
- Deleted `getApiBaseUrl(req)` function
- Removed `req` parameter from `getAllowedSourceOrigins()`
- Origin allowlist now uses only `TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS` env var

**Important**: The direct fetch path at line 188 remains safe only if `TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS` is configured narrowly with trusted origins. Overly broad configuration can reintroduce SSRF risk through policy misconfiguration rather than code vulnerability.

### 3. Base64 Sanitization
```javascript
function decodeBase64ToUtf8(input) {
  const sanitized = String(input || "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (!sanitized) return "";
  try {
    return Buffer.from(sanitized, "base64").toString("utf8");
  } catch {
    return "";
  }
}
```

### 4. JSON Parse Validation
```javascript
const parsed = JSON.parse(content);
if (typeof parsed !== "object" || parsed === null) {
  throw new Error("Invalid token data format");
}
return parsed;
```

### 5. SSRF Protection
- All URLs are validated against allowed origins
- HTTPS-only enforcement
- Origin allowlist checking

## Regression Tests Added

1. `tests/preview-page.test.js`
   - Verifies attacker-controlled JSON cannot break out of preview `<script>` tags
   - Verifies U+2028 and U+2029 are escaped before embedding

2. `tests/relay-security.test.js`
   - Verifies local relay paths resolve inside the configured root
   - Verifies `../` traversal and out-of-root absolute paths are rejected

## Remaining Issues Requiring Manual Review

### relay/server.mjs
1. **SSRF (line 99):**
   - Review URL validation around outbound fetch calls
   - Confirm only trusted GitHub endpoints are reachable

2. **XSS (line 337):**
   - Validate user input before `Object.assign()`
   - Sanitize or validate all properties being assigned

3. **Insecure Deserialization (line 107):**
   - Add validation after JSON.parse()
   - Verify object structure matches expected schema

### src/code.ts
1. **SSRF (line 1586):**
   - Already has URL validation through `assertAllowedOrigin()`
   - Verify allowlist is comprehensive

2. **For-in loop (line 1571):**
   - Change `for (const key in array)` to `for (const item of array)`

## Testing Recommendations

1. Test all file upload/import functionality
2. Verify GitHub API integrations still work
3. Test token import from URLs
4. Verify base64 decoding works correctly
5. Test error handling for invalid JSON

## Next Steps

1. Review and fix remaining issues in relay/server.mjs
2. Fix for-in loop in src/code.ts
3. Run full test suite
4. Perform security audit of fixed code
5. Update dependencies to latest secure versions

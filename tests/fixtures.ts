// tests/fixtures.ts - Test fixtures for integration tests
// 5 sample notes representing different states and scenarios

/**
 * Fixture 1: Permanent note (high-value, stable)
 */
export const fixturePermanentNote = {
  id: '202602081000',
  filename: '202602081000-react-hooks-pattern.md',
  content: `---
id: 202602081000
title: React Hooks Pattern
status: permanent
type: atomic
tags:
  - react
  - hooks
  - pattern
created: 2026-02-08
updated: 2026-02-08
---

# React Hooks Pattern

## Overview
This note documents the useEffect cleanup pattern for React applications.

## Pattern Details

### Problem
When using useEffect for subscriptions or event listeners, memory leaks can occur if cleanup is not handled properly.

### Solution
Always return a cleanup function from useEffect when setting up subscriptions.

\`\`\`jsx
useEffect(() => {
  const subscription = api.subscribe();
  return () => {
    subscription.unsubscribe();
  };
}, []);
\`\`\`

## Best Practices
1. Always cleanup subscriptions
2. Use empty dependency array for mount-only effects
3. Handle race conditions with cancellation tokens

## Related
- [[202602081001]] - Component Lifecycle
- [[202602081002]] - Memory Management`,
  wordCount: 145
};

/**
 * Fixture 2: Active fleeting note (recent, has links)
 */
export const fixtureActiveFleetingNote = {
  id: '202602081001',
  filename: '202602081001-component-lifecycle.md',
  content: `---
id: 202602081001
title: Component Lifecycle
status: fleeting
type: atomic
tags:
  - react
  - lifecycle
context: frontend
created: 2026-02-08
updated: 2026-02-08
---

# Component Lifecycle

Quick notes on React component lifecycle phases:

## Mounting
- constructor
- render
- componentDidMount

## Updating
- render
- componentDidUpdate

## Unmounting
- componentWillUnmount

## Notes
Need to expand this with hooks equivalent patterns.

Incoming links: [[202602081000]] references this.`,
  wordCount: 65
};

/**
 * Fixture 3: Stale fleeting note (old, no links)
 */
export const fixtureStaleFleetingNote = {
  id: '202601011000',
  filename: '202601011000-old-idea.md',
  content: `---
id: 202601011000
title: Old Idea for State Management
status: fleeting
type: atomic
tags:
  - idea
  - draft
created: 2026-01-01
updated: 2026-01-01
---

# Old Idea for State Management

This was an idea about using Redux with custom middleware.

Never fully developed. No other notes reference this.

Should probably be archived if not developed further.`,
  wordCount: 42
};

/**
 * Fixture 4: Large note (candidate for sharding)
 */
export const fixtureLargeNote = {
  id: '202602081002',
  filename: '202602081002-complete-api-guide.md',
  content: `---
id: 202602081002
title: Complete API Guide
status: permanent
type: atomic
tags:
  - api
  - guide
  - backend
context: api-design
created: 2026-02-08
updated: 2026-02-08
---

# Complete API Guide

## Overview
This guide covers everything about REST API design and implementation.

## Authentication

### JWT Tokens
JSON Web Tokens are the recommended approach for stateless authentication.

Benefits:
- Stateless
- Self-contained
- Industry standard

Implementation:
\`\`\`javascript
const token = jwt.sign(payload, secret, { expiresIn: '1h' });
\`\`\`

### OAuth 2.0
For third-party integrations, use OAuth 2.0 flow.

## Rate Limiting

### Token Bucket
Use token bucket algorithm for rate limiting.

Configuration:
- 100 requests per minute
- Burst up to 150 requests
- Reset every 60 seconds

### Headers
Always return rate limit headers:
- X-RateLimit-Limit
- X-RateLimit-Remaining
- X-RateLimit-Reset

## Error Handling

### Standard Format
All errors should follow RFC 7807 (Problem Details).

\`\`\`json
{
  "type": "https://api.example.com/errors/not-found",
  "title": "Resource Not Found",
  "status": 404,
  "detail": "The requested user does not exist",
  "instance": "/users/123"
}
\`\`\`

### Error Codes
Common error codes:
- 400 - Bad Request
- 401 - Unauthorized
- 403 - Forbidden
- 404 - Not Found
- 409 - Conflict
- 422 - Unprocessable Entity
- 429 - Too Many Requests
- 500 - Internal Server Error

## Pagination

### Cursor-Based
Use cursor-based pagination for large datasets.

Benefits:
- Consistent performance
- No skipping issues
- Handles concurrent modifications

### Offset-Based
Use offset-based for small, stable datasets.

## Caching

### Cache-Control Headers
Set appropriate cache headers:
- public - Can be cached by anyone
- private - Only browser can cache
- no-cache - Must revalidate
- max-age - How long to cache

### ETags
Use ETags for conditional requests.

\`\`\`http
ETag: "33a64df5"
If-None-Match: "33a64df5"
\`\`\`

## Versioning

### URL Versioning
Include version in URL path:
- /v1/users
- /v2/users

### Header Versioning
Alternative approach using Accept header:
\`\`\`http
Accept: application/vnd.api+json;version=2
\`\`\`

## Security

### HTTPS Only
Never accept HTTP requests in production.

### CORS
Configure CORS properly:
- Whitelist specific origins
- Limit allowed methods
- Control exposed headers

### Input Validation
Validate all inputs:
- Schema validation
- Sanitization
- Type checking

## Documentation

### OpenAPI
Use OpenAPI 3.0 for API documentation.

Benefits:
- Interactive documentation
- Client generation
- Testing tools

### Examples
Always include practical examples for each endpoint.`,
  wordCount: 540 // Exceeds the 500-word test threshold
};

/**
 * Fixture 5: Note with broken link
 */
export const fixtureBrokenLinkNote = {
  id: '202602081003',
  filename: '202602081003-architecture-overview.md',
  content: `---
id: 202602081003
title: Architecture Overview
status: permanent
type: atomic
tags:
  - architecture
  - overview
context: system-design
created: 2026-02-08
updated: 2026-02-08
---

# Architecture Overview

## System Design

This document provides a high-level overview of the system architecture.

## Components

### Frontend
Built with React and TypeScript.
See [[202602081000]] for hook patterns.

### Backend
REST API built with Node.js.
See [[202602081002]] for API guide.

### Database
PostgreSQL for persistent storage.

## Common Mistakes

- Not handling cleanup properly (see [[202602081000]])
- Poor API design (see [[202602081002]])

## Typo Link
This link has a typo: [[202602081000-react-hooks-patern]]
Should be: [[202602081000]]`,
  wordCount: 112
};

/**
 * Fixture 6: Update content for testing intelligent merge
 */
export const fixtureUpdateContent = {
  content: `Additional information about React Hooks:

### useCallback
Use useCallback to memoize functions passed to child components.

### useMemo
Use useMemo for expensive computations.

These patterns help optimize performance.`
};

/**
 * Fixture 7: Contradictory content for testing auto-archive
 */
export const fixtureContradictionContent = {
  content: `---
id: 202602081000-new
title: React Hooks Pattern (Updated)
status: permanent
type: atomic
tags:
  - react
  - hooks
  - pattern
  - updated
created: 2026-02-08
updated: 2026-02-08
---

# React Hooks Pattern (Revised)

## Important Update

The previous useEffect cleanup pattern documented in [[202602081000]] is now outdated.

## New Recommended Approach

React 18 introduces automatic batching and new hooks that make the old cleanup pattern unnecessary in most cases.

### Modern Pattern
Use the new useId hook and automatic cleanup:

\`\`\`jsx
useEffect(() => {
  // React 18 handles cleanup automatically
  const subscription = api.subscribe();
  // No explicit return needed in most cases
}, []);
\`\`\`

## Migration
Update all existing components to use the new pattern.
See [[202602081000]] for the old approach (now deprecated).`
};

/**
 * All fixtures as an array for easy setup
 */
export const allFixtures = [
  fixturePermanentNote,
  fixtureActiveFleetingNote,
  fixtureStaleFleetingNote,
  fixtureLargeNote,
  fixtureBrokenLinkNote
];

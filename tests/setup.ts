// Bun test configuration and setup
// This file sets up the test environment for bun:test

// Extend expect with additional matchers if needed
// Bun's expect has most Jest matchers built-in

// Setup test environment
process.env.NODE_ENV = 'test';

// Export test utilities for convenience
export { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, mock, spyOn } from 'bun:test';

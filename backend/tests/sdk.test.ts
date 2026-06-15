import { describe, it, expect } from 'vitest';
import { NodeRegistry } from '../src/registry.js';
import { executeNode } from '../src/nodes.js';
import { LibreFlowNodeDefinition } from '../src/sdk.js';

describe('SDK & NodeRegistry', () => {
  it('should allow registering a custom node type and executing it', async () => {
    const customNode: LibreFlowNodeDefinition = {
      type: 'customMath',
      displayName: 'Custom Math Node',
      category: 'Utility',
      icon: '➕',
      description: 'Adds two numbers',
      parameters: [
        { name: 'num1', label: 'Number 1', type: 'number', default: 0 },
        { name: 'num2', label: 'Number 2', type: 'number', default: 0 }
      ],
      execute: async (params) => {
        return {
          result: (params.num1 || 0) + (params.num2 || 0)
        };
      }
    };

    // Register custom node
    NodeRegistry.register(customNode);

    // Verify it is registered
    const retrieved = NodeRegistry.getNodeType('customMath');
    expect(retrieved).toBeDefined();
    expect(retrieved?.displayName).toBe('Custom Math Node');

    // Execute node through executeNode helper
    const nodeObj = {
      id: 'node-test-1',
      type: 'customMath',
      name: 'MyCustomMathNode',
      parameters: {
        num1: 10,
        num2: 15
      }
    };

    // Context can be empty for this simple execution
    const context = {};

    const output = await executeNode(nodeObj, context);
    expect(output).toEqual({ result: 25 });
  });

  it('should list all registered node types including the custom one', () => {
    const allTypes = NodeRegistry.getAllNodeTypes();
    const customMathExists = allTypes.some(t => t.type === 'customMath');
    expect(customMathExists).toBe(true);
  });
});

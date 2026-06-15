import { ExecutionContext } from './engine.js';
import { NodeRegistry } from './registry.js';

export interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  parameters: Record<string, any>;
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Helper to resolve nested properties of an object using an array of keys
function getNestedValue(obj: any, path: string[]): any {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    // Block prototype-pollution traversal (e.g. {{ $node.X.output.__proto__ }}).
    if (UNSAFE_KEYS.has(key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

// Helper to resolve expressions like {{ $node.NodeName.output.key }}
export function resolveValue(value: any, context: ExecutionContext): any {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) {
      return value.map(item => resolveValue(item, context));
    }
    if (value !== null && typeof value === 'object') {
      const resolvedObj: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolvedObj[k] = resolveValue(v, context);
      }
      return resolvedObj;
    }
    return value;
  }

  // Check if the whole string is a single expression like "{{ $node.Node.output.data }}"
  const fullExpressionMatch = value.trim().match(/^\{\{\s*(.*?)\s*\}\}$/);
  if (fullExpressionMatch) {
    return evaluateExpression(fullExpressionMatch[1], context);
  }

  // Otherwise interpolate expressions inside a string (e.g. "Hello {{ $node.Set.output.name }}!")
  return value.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    const resolved = evaluateExpression(expression, context);
    if (resolved === undefined || resolved === null) return '';
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
}

function evaluateExpression(expression: string, context: ExecutionContext): any {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('$node.')) {
    return undefined;
  }

  // Parse path: $node.NodeName.output.foo.bar
  const parts = trimmed.split('.');
  if (parts.length < 3) {
    return undefined;
  }

  const nodeName = parts[1];
  const nodeContext = context[nodeName];
  if (!nodeContext) {
    return undefined;
  }

  // parts[2] should be "output"
  const path = parts.slice(2); // e.g. ["output", "foo", "bar"]
  return getNestedValue(nodeContext, path);
}

// Execution function mapping to SDK Registry.
// `paramOverrides` lets the engine inject ephemeral params (loop state, trigger payload)
// WITHOUT mutating the shared node object — keeping executions deterministic on re-runs.
export async function executeNode(
  node: WorkflowNode,
  context: ExecutionContext,
  incomingInputs?: Record<string, any>,
  execMeta?: { depth?: number; stack?: string[] },
  paramOverrides?: Record<string, any>
): Promise<any> {
  const effectiveParams = paramOverrides
    ? { ...node.parameters, ...paramOverrides }
    : node.parameters;
  const resolvedParams = resolveValue(effectiveParams, context);

  const nodeDef = NodeRegistry.getNodeType(node.type);
  if (!nodeDef) {
    throw new Error(`Unsupported node type: ${node.type}`);
  }

  return await nodeDef.execute(resolvedParams, context, incomingInputs, execMeta);
}

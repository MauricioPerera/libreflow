export interface NodeParameterSchema {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'options' | 'code' | 'json' | 'expression' | 'keyvalue';
  default?: any;
  placeholder?: string;
  description?: string;
  options?: { label: string; value: any }[];
  minHeight?: string;
}

export interface LibreFlowNodeDefinition {
  type: string;
  displayName: string;
  category: 'Trigger' | 'Data' | 'Flow' | 'Utility' | 'Integration' | 'AI';
  icon: string;
  description: string;
  ui?: {
    subtitle?: string;
    inputs?: { id?: string; label?: string; topPercent?: number }[];
    outputs?: { id?: string; label?: string; topPercent?: number }[];
    gradient?: string;
  };
  parameters: NodeParameterSchema[];
  execute: (
    parameters: any,
    context: any,
    incomingInputs?: any,
    execMeta?: { depth?: number; stack?: string[]; executionId?: string; ownerId?: string | null; isAdmin?: boolean }
  ) => Promise<any> | any;
}

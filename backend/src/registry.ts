import { LibreFlowNodeDefinition } from './sdk.js';
import { getCredentialById, getWorkflowById } from './db.js';
import { Worker } from 'worker_threads';
import { executeMcpToolCall } from './mcp.js';
import { assertSafeUrl, isUnsafeKey } from './security.js';

/** Builds a plain object from key/value pairs, skipping prototype-pollution keys. */
function safeAssignKeyValues(values: any[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const item of values || []) {
    if (item && typeof item.key === 'string' && !isUnsafeKey(item.key)) {
      result[item.key] = item.value;
    }
  }
  return result;
}

const triggerNode: LibreFlowNodeDefinition = {
  type: 'trigger',
  displayName: 'Trigger (Inicio)',
  category: 'Trigger',
  icon: '⚡',
  description: 'Punto de inicio para la ejecución de flujos de trabajo',
  ui: {
    subtitle: 'Inicio del Flujo',
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(var(--color-primary)), #7033ff)'
  },
  parameters: [
    {
      name: 'triggerMode',
      label: 'Modo de Disparo',
      type: 'options',
      default: 'manual',
      options: [
        { label: 'Manual (Ejecución directa)', value: 'manual' },
        { label: 'Webhook (URL Externa)', value: 'webhook' },
        { label: 'Cron (Programado)', value: 'cron' }
      ]
    },
    {
      name: 'cronExpression',
      label: 'Expresión Cron',
      type: 'string',
      default: '*/5 * * * *',
      placeholder: '*/5 * * * * (Cada 5 minutos)'
    },
    {
      name: 'inputSchema',
      label: 'Esquema de Entrada (JSON Schema para MCP)',
      type: 'json',
      default: '{\n  "type": "object",\n  "properties": {}\n}',
      placeholder: 'JSON Schema de los parámetros de entrada',
      description: 'Define los parámetros que espera este flujo cuando es invocado como herramienta de IA / MCP.'
    }
  ],
  execute: async (params) => {
    return {
      success: true,
      timestamp: new Date().toISOString(),
      payload: params.payload || {}
    };
  }
};

const setNode: LibreFlowNodeDefinition = {
  type: 'set',
  displayName: 'Establecer (Set)',
  category: 'Data',
  icon: 'S',
  description: 'Define o edita variables y valores en el contexto',
  ui: {
    subtitle: 'Establecer variables',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(var(--color-warning)), #ff7700)'
  },
  parameters: [
    {
      name: 'values',
      label: 'Variables a definir',
      type: 'keyvalue',
      default: [{ key: '', value: '' }]
    }
  ],
  execute: async (params) => {
    return safeAssignKeyValues(params.values || []);
  }
};

const httpRequestNode: LibreFlowNodeDefinition = {
  type: 'httpRequest',
  displayName: 'Petición HTTP',
  category: 'Integration',
  icon: 'H',
  description: 'Realiza peticiones HTTP a APIs REST externas',
  ui: {
    subtitle: 'Petición HTTP API',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(var(--color-info)), #0088ff)'
  },
  parameters: [
    {
      name: 'url',
      label: 'URL',
      type: 'string',
      default: '',
      placeholder: 'https://api.ejemplo.com/datos'
    },
    {
      name: 'method',
      label: 'Método',
      type: 'options',
      default: 'GET',
      options: [
        { label: 'GET', value: 'GET' },
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
        { label: 'PATCH', value: 'PATCH' },
        { label: 'DELETE', value: 'DELETE' }
      ]
    },
    {
      name: 'authentication',
      label: 'Autenticación',
      type: 'options',
      default: 'none',
      options: [
        { label: 'Ninguna', value: 'none' },
        { label: 'Credencial Genérica', value: 'genericCredential' }
      ]
    },
    {
      name: 'credentialId',
      label: 'Credencial Asociada',
      type: 'options',
      default: ''
    },
    {
      name: 'headers',
      label: 'Cabeceras (Headers)',
      type: 'keyvalue',
      default: [{ key: '', value: '' }]
    },
    {
      name: 'body',
      label: 'Cuerpo (Body)',
      type: 'code',
      default: ''
    }
  ],
  execute: async (params) => {
    const { 
      url, 
      method = 'GET', 
      headers = [], 
      body,
      authentication = 'none',
      credentialId
    } = params;

    if (!url) {
      throw new Error('HTTP Request Node error: URL is required');
    }

    // SSRF guard: validate the target before making the request.
    await assertSafeUrl(url);

    const headerObj: Record<string, string> = {};
    for (const h of headers) {
      if (h && h.key) {
        headerObj[h.key] = h.value;
      }
    }

    let requestUrl = url;

    if (authentication === 'genericCredential' && credentialId) {
      const cred = await getCredentialById(credentialId);
      if (cred && cred.data) {
        if (cred.type === 'basicAuth') {
          const { user = '', password = '' } = cred.data;
          const authString = Buffer.from(`${user}:${password}`).toString('base64');
          headerObj['Authorization'] = `Basic ${authString}`;
        } else if (cred.type === 'apiKey') {
          const { name = '', value = '', in: keyIn = 'header' } = cred.data;
          if (name && value) {
            if (keyIn === 'query') {
              const parsedUrl = new URL(url);
              parsedUrl.searchParams.append(name, value);
              requestUrl = parsedUrl.toString();
            } else {
              headerObj[name] = value;
            }
          }
        }
      } else {
        console.warn(`[Node: httpRequest] Credential not found or failed to load: ${credentialId}`);
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: headerObj,
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && body) {
      fetchOptions.body = typeof body === 'object' ? JSON.stringify(body) : String(body);
      if (!headerObj['Content-Type']) {
        headerObj['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(requestUrl, fetchOptions);
    const text = await response.text();
    let responseBody: any;
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }

    const resHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders,
      body: responseBody
    };
  }
};

const jsCodeNode: LibreFlowNodeDefinition = {
  type: 'jsCode',
  displayName: 'Código JS',
  category: 'Utility',
  icon: 'JS',
  description: 'Ejecuta código JavaScript en un sandbox aislado',
  ui: {
    subtitle: 'Transformar Código',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(45, 90%, 50%), hsl(35, 100%, 50%))'
  },
  parameters: [
    {
      name: 'code',
      label: 'Código JS',
      type: 'code',
      default: '// Escribe tu script aquí\nreturn { resultado: "Hola" };'
    }
  ],
  execute: async (params, context) => {
    // SECURITY: this worker has full Node access (require/fs/child_process) — it is NOT
    // a real sandbox. Disabled by default in production; enable only on trusted instances.
    // The hardened path is to run user code in isolated-vm with no host bindings.
    const jsCodeEnabled =
      process.env.LF_ENABLE_JS_CODE === 'true' || process.env.NODE_ENV !== 'production';
    if (!jsCodeEnabled) {
      throw new Error(
        'jsCode node is disabled. It executes arbitrary code with full host access. ' +
        'Set LF_ENABLE_JS_CODE=true only on a trusted, isolated instance.'
      );
    }

    const code = params.code || 'return {};';
    const timeoutMs = 5000;

    return new Promise((resolve, reject) => {
      const workerCode = `
        const { parentPort, workerData } = require('worker_threads');

        async function run() {
          const { code, context } = workerData;

          const $node = new Proxy({}, {
            get(target, prop) {
              if (typeof prop === 'string') {
                return context[prop] || { output: {} };
              }
              return undefined;
            }
          });

          try {
            const fn = new Function('$node', 'context', \`
              const run = async () => {
                \${code}
              };
              return run();
            \`);
            const result = await fn($node, context);
            parentPort.postMessage({ success: true, result });
          } catch (err) {
            parentPort.postMessage({ success: false, error: err.message });
          }
        }

        run();
      `;

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { code, context }
      });

      const timeout = setTimeout(() => {
        worker.terminate().catch(console.error);
        reject(new Error(`JS Code execution timed out (limit: ${timeoutMs}ms)`));
      }, timeoutMs);

      worker.on('message', (message) => {
        clearTimeout(timeout);
        worker.terminate().catch(console.error);
        if (message.success) {
          resolve(message.result === undefined ? {} : message.result);
        } else {
          reject(new Error(`JS Code execution failed: ${message.error}`));
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timeout);
        worker.terminate().catch(console.error);
        reject(err);
      });

      worker.on('exit', (exitCode) => {
        clearTimeout(timeout);
        worker.terminate().catch(console.error);
        if (exitCode !== 0) {
          reject(new Error(`Worker stopped with exit code ${exitCode}`));
        } else {
          resolve({});
        }
      });
    });
  }
};

const ifNode: LibreFlowNodeDefinition = {
  type: 'if',
  displayName: 'Condición IF',
  category: 'Flow',
  icon: '?',
  description: 'Bifurca el flujo de trabajo basándose en una condición lógica',
  ui: {
    subtitle: 'Bifurcación lógica',
    inputs: [{ id: 'main' }],
    outputs: [
      { id: 'true', label: 'True', topPercent: 30 },
      { id: 'false', label: 'False', topPercent: 70 }
    ],
    gradient: 'linear-gradient(135deg, hsl(300, 80%, 55%), hsl(270, 80%, 55%))'
  },
  parameters: [
    {
      name: 'value1',
      label: 'Valor 1',
      type: 'string',
      default: ''
    },
    {
      name: 'operator',
      label: 'Operador',
      type: 'options',
      default: 'equal',
      options: [
        { label: 'Igual', value: 'equal' },
        { label: 'Diferente', value: 'notEqual' },
        { label: 'Contiene', value: 'contains' },
        { label: 'Mayor que', value: 'greaterThan' },
        { label: 'Menor que', value: 'lessThan' }
      ]
    },
    {
      name: 'value2',
      label: 'Valor 2',
      type: 'string',
      default: ''
    }
  ],
  execute: async (params) => {
    const { value1, operator = 'equal', value2 } = params;
    let result = false;

    const val1Str = String(value1);
    const val2Str = String(value2);

    switch (operator) {
      case 'equal':
        result = value1 == value2;
        break;
      case 'notEqual':
        result = value1 != value2;
        break;
      case 'contains':
        result = val1Str.includes(val2Str);
        break;
      case 'greaterThan':
        result = Number(value1) > Number(value2);
        break;
      case 'lessThan':
        result = Number(value1) < Number(value2);
        break;
      default:
        result = false;
    }

    return {
      result,
      value1,
      value2,
      operator
    };
  }
};

const logNode: LibreFlowNodeDefinition = {
  type: 'log',
  displayName: 'Consola Log',
  category: 'Utility',
  icon: 'L',
  description: 'Imprime un mensaje en la consola del servidor para depuración',
  ui: {
    subtitle: 'Registrar en Log',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(var(--color-success)), #00aa66)'
  },
  parameters: [
    {
      name: 'message',
      label: 'Mensaje',
      type: 'string',
      default: ''
    }
  ],
  execute: async (params, context, incomingInputs) => {
    const message = params.message || '';
    console.log(`[LibreFlow Log Node]`, message);
    return {
      message,
      loggedAt: new Date().toISOString()
    };
  }
};

const mergeNode: LibreFlowNodeDefinition = {
  type: 'merge',
  displayName: 'Fusionar (Merge)',
  category: 'Flow',
  icon: '🔀',
  description: 'Une múltiples ramas paralelas en un solo canal de datos',
  ui: {
    subtitle: 'Fusionar Entradas',
    inputs: [
      { id: 'input1', label: 'Input 1', topPercent: 30 },
      { id: 'input2', label: 'Input 2', topPercent: 70 }
    ],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(280, 85%, 60%), hsl(250, 85%, 60%))'
  },
  parameters: [
    {
      name: 'mode',
      label: 'Modo de Fusión',
      type: 'options',
      default: 'combine',
      options: [
        { label: 'Combinar Objetos', value: 'combine' },
        { label: 'Esperar ambas ramas', value: 'wait' },
        { label: 'Anexar Listas', value: 'append' }
      ]
    }
  ],
  execute: async (params, context, incomingInputs) => {
    const mode = params.mode || 'combine';
    const input1 = incomingInputs?.input1;
    const input2 = incomingInputs?.input2;

    switch (mode) {
      case 'wait': {
        return {
          input1,
          input2
        };
      }
      case 'combine': {
        const isObj1 = input1 !== null && typeof input1 === 'object' && !Array.isArray(input1);
        const isObj2 = input2 !== null && typeof input2 === 'object' && !Array.isArray(input2);
        
        if (isObj1 && isObj2) {
          return { ...input1, ...input2 };
        } else if (isObj1) {
          return { ...input1, input2 };
        } else if (isObj2) {
          return { input1, ...input2 };
        } else {
          return { input1, input2 };
        }
      }
      case 'append': {
        const arr1 = Array.isArray(input1) ? input1 : (input1 !== undefined ? [input1] : []);
        const arr2 = Array.isArray(input2) ? input2 : (input2 !== undefined ? [input2] : []);
        return [...arr1, ...arr2];
      }
      default:
        throw new Error(`Unsupported merge mode: ${mode}`);
    }
  }
};

const executeWorkflowNode: LibreFlowNodeDefinition = {
  type: 'executeWorkflow',
  displayName: 'Sub-workflow',
  category: 'Flow',
  icon: '🔄',
  description: 'Llama y ejecuta otro flujo de trabajo guardado',
  ui: {
    subtitle: 'Llamar Flujo',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(180, 75%, 45%), hsl(150, 75%, 45%))'
  },
  parameters: [
    {
      name: 'targetWorkflowId',
      label: 'Flujo Destino',
      type: 'options',
      default: ''
    },
    {
      name: 'payload',
      label: 'Payload de Entrada (JSON)',
      type: 'code',
      default: ''
    }
  ],
  execute: async (params, _context, _incomingInputs, execMeta) => {
    const { targetWorkflowId, payload } = params;
    if (!targetWorkflowId) {
      throw new Error('Sub-workflow Node error: targetWorkflowId is required');
    }

    // Guard against runaway / cyclic sub-workflow recursion (stack overflow / DoS).
    const depth: number = execMeta?.depth ?? 0;
    const stack: string[] = execMeta?.stack ?? [];
    const MAX_DEPTH = 10;
    if (depth >= MAX_DEPTH) {
      throw new Error(`Sub-workflow Node error: maximum nesting depth (${MAX_DEPTH}) exceeded`);
    }
    if (stack.includes(targetWorkflowId)) {
      throw new Error(`Sub-workflow Node error: cyclic sub-workflow call detected for "${targetWorkflowId}"`);
    }

    const workflow = await getWorkflowById(targetWorkflowId);
    if (!workflow) {
      throw new Error(`Sub-workflow Node error: Workflow with ID ${targetWorkflowId} not found`);
    }

    let initialPayload = {};
    if (payload) {
      if (typeof payload === 'string') {
        try {
          initialPayload = JSON.parse(payload);
        } catch {
          throw new Error('Sub-workflow Node error: Payload must be a valid JSON string');
        }
      } else if (typeof payload === 'object') {
        initialPayload = payload;
      }
    }

    const { WorkflowEngine } = await import('./engine.js');
    const subEngine = new WorkflowEngine();
    const report = await subEngine.execute(workflow, initialPayload, {
      depth: depth + 1,
      stack: [...stack, targetWorkflowId],
    });

    if (!report.success) {
      const errorDetail = Object.values(report.nodeResults)
        .find(r => r.status === 'failed')?.error || 'Sub-workflow failed';
      throw new Error(`Sub-workflow execution failed: ${errorDetail}`);
    }

    return {
      success: true,
      durationMs: report.durationMs,
      nodeResults: report.nodeResults
    };
  }
};

const loopNode: LibreFlowNodeDefinition = {
  type: 'loop',
  displayName: 'Bucle (Loop)',
  category: 'Flow',
  icon: '⟳',
  description: 'Itera de forma repetitiva sobre una lista de elementos',
  ui: {
    subtitle: 'Iterar sobre lista',
    inputs: [{ id: 'main' }],
    outputs: [
      { id: 'loop', label: 'Loop', topPercent: 30 },
      { id: 'done', label: 'Done', topPercent: 70 }
    ],
    gradient: 'linear-gradient(135deg, hsl(30, 95%, 55%), hsl(15, 95%, 50%))'
  },
  parameters: [
    {
      name: 'items',
      label: 'Elementos a iterar',
      type: 'string',
      default: '[]'
    }
  ],
  execute: async (params) => {
    const currentIndex = params._currentIndex ?? 0;
    const items = params._items || [];
    const results = params._results || [];
    
    if (items.length === 0 || currentIndex >= items.length) {
      return {
        done: true,
        results
      };
    }
    
    return {
      done: false,
      item: items[currentIndex],
      index: currentIndex,
      isLast: currentIndex === items.length - 1
    };
  }
};

const mcpToolCallNode: LibreFlowNodeDefinition = {
  type: 'mcpToolCall',
  displayName: 'Llamada Herramienta MCP',
  category: 'Integration',
  icon: '🔌',
  description: 'Conecta con un servidor MCP externo y ejecuta una de sus herramientas',
  ui: {
    subtitle: 'Llamada MCP Tool',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(200, 80%, 45%), hsl(175, 80%, 40%))'
  },
  parameters: [
    {
      name: 'serverUrl',
      label: 'URL del Servidor MCP',
      type: 'string',
      default: 'http://localhost:3000/mcp/<id>',
      placeholder: 'Streamable HTTP (recomendado) o SSE',
      description: 'Acepta servidores MCP estándar: Streamable HTTP (transporte actual) o SSE (legacy).'
    },
    {
      name: 'authentication',
      label: 'Autenticación',
      type: 'options',
      default: 'none',
      options: [
        { label: 'Ninguna', value: 'none' },
        { label: 'Credencial Genérica', value: 'genericCredential' }
      ]
    },
    {
      name: 'credentialId',
      label: 'Credencial Asociada',
      type: 'options',
      default: ''
    },
    {
      name: 'toolName',
      label: 'Nombre de la Herramienta',
      type: 'options',
      default: '',
      options: []
    },
    {
      name: 'arguments',
      label: 'Argumentos',
      type: 'keyvalue',
      default: []
    }
  ],
  execute: async (params) => {
    const { serverUrl, toolName, arguments: argsList, authentication = 'none', credentialId } = params;
    if (!serverUrl || !toolName) {
      throw new Error('MCP Tool Call Node error: serverUrl and toolName are required');
    }

    // SSRF guard on the user-supplied MCP server URL.
    await assertSafeUrl(serverUrl);

    const argsObj: Record<string, any> = {};
    if (Array.isArray(argsList)) {
      for (const item of argsList) {
        if (item && item.key && !isUnsafeKey(item.key)) {
          let val = item.value;
          if (typeof val === 'string') {
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (!isNaN(Number(val)) && val.trim() !== '') val = Number(val);
          }
          argsObj[item.key] = val;
        }
      }
    } else if (argsList && typeof argsList === 'object') {
      Object.assign(argsObj, argsList);
    }

    // Resolve auth from the encrypted credentials vault (same scheme as httpRequest):
    // basicAuth -> Authorization: Basic; apiKey -> custom header or query parameter.
    let requestUrl = serverUrl;
    const headers: Record<string, string> = {};
    if (authentication === 'genericCredential' && credentialId) {
      const cred = await getCredentialById(credentialId);
      if (cred && cred.data) {
        if (cred.type === 'basicAuth') {
          const { user = '', password = '' } = cred.data;
          headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
        } else if (cred.type === 'apiKey') {
          const { name = '', value = '', in: keyIn = 'header' } = cred.data;
          if (name && value) {
            if (keyIn === 'query') {
              const parsedUrl = new URL(serverUrl);
              parsedUrl.searchParams.append(name, value);
              requestUrl = parsedUrl.toString();
            } else {
              headers[name] = value;
            }
          }
        }
      } else {
        console.warn(`[Node: mcpToolCall] Credential not found or failed to load: ${credentialId}`);
      }
    }

    return await executeMcpToolCall(requestUrl, toolName, argsObj, headers);
  }
};

const dataTableNode: LibreFlowNodeDefinition = {
  type: 'dataTable',
  displayName: 'Tabla de Datos',
  category: 'Data',
  icon: '📊',
  description: 'Permite leer, escribir, buscar y borrar filas en las Tablas de Datos del sistema',
  ui: {
    subtitle: 'Operar Tabla de Datos',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, #00c6ff, #0072ff)'
  },
  parameters: [
    {
      name: 'operation',
      label: 'Operación',
      type: 'options',
      default: 'append',
      options: [
        { label: 'Añadir fila (Append)', value: 'append' },
        { label: 'Buscar filas (Search)', value: 'search' },
        { label: 'Actualizar fila (Update)', value: 'update' },
        { label: 'Eliminar fila (Delete)', value: 'delete' },
        { label: 'Insertar/Actualizar por clave (Upsert)', value: 'upsert' },
        { label: 'Incrementar contador (Increment)', value: 'increment' },
        { label: 'Obtener o crear por clave (Get or Default)', value: 'getOrDefault' },
        { label: 'Consultar con operadores (Query)', value: 'query' }
      ]
    },
    {
      name: 'tableId',
      label: 'Tabla de Datos',
      type: 'options',
      default: '',
      options: []
    },
    {
      name: 'rowId',
      label: 'ID de Fila',
      type: 'string',
      default: '',
      placeholder: 'row-123456789'
    },
    {
      name: 'key',
      label: 'Valor de la Clave (upsert/increment/get)',
      type: 'string',
      default: '',
      placeholder: 'p.ej. el email o id que identifica la fila'
    },
    {
      name: 'field',
      label: 'Campo a Incrementar',
      type: 'string',
      default: 'count'
    },
    {
      name: 'amount',
      label: 'Incremento',
      type: 'string',
      default: '1'
    },
    {
      name: 'fields',
      label: 'Campos de la Fila',
      type: 'keyvalue',
      default: []
    },
    {
      name: 'filters',
      label: 'Filtros de Búsqueda',
      type: 'keyvalue',
      default: []
    },
    {
      name: 'queryFilters',
      label: 'Filtros de Consulta (Query, JSON)',
      type: 'json',
      default: '[]',
      placeholder: '[{"column":"status","op":"eq","value":"active"}]',
      description: 'Operadores: eq, ne, gt, lt, gte, lte, contains, in.'
    },
    {
      name: 'sortColumn',
      label: 'Ordenar por (columna)',
      type: 'string',
      default: ''
    },
    {
      name: 'sortDir',
      label: 'Dirección de orden',
      type: 'options',
      default: 'asc',
      options: [
        { label: 'Ascendente', value: 'asc' },
        { label: 'Descendente', value: 'desc' }
      ]
    },
    {
      name: 'limit',
      label: 'Límite de resultados',
      type: 'string',
      default: '100'
    }
  ],
  execute: async (params) => {
    const { operation = 'append', tableId, rowId, fields = [], filters = [], key, field = 'count', amount = '1' } = params;
    if (!tableId) {
      throw new Error('Data Table Node error: tableId is required');
    }

    const {
      getDataTableRows, addDataTableRow, updateDataTableRow, deleteDataTableRow,
      upsertDataTableRow, incrementDataTableRow, getOrCreateDataTableRow, queryDataTableRows
    } = await import('./db.js');

    // Coerces keyvalue pairs into a typed object (string→bool/number), shared by write ops.
    const buildDataObject = (items: any[]): Record<string, any> => {
      const obj: Record<string, any> = {};
      for (const item of items || []) {
        if (item && item.key) {
          let val = item.value;
          if (typeof val === 'string') {
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (!isNaN(Number(val)) && val.trim() !== '') val = Number(val);
          }
          obj[item.key] = val;
        }
      }
      return obj;
    };

    if (operation === 'upsert') {
      return await upsertDataTableRow(tableId, buildDataObject(fields));
    }

    if (operation === 'increment') {
      if (!key) throw new Error('Data Table Node error: key is required for increment operation');
      const amt = Number(amount);
      return await incrementDataTableRow(tableId, String(key), field, isNaN(amt) ? 1 : amt);
    }

    if (operation === 'getOrDefault') {
      if (!key) throw new Error('Data Table Node error: key is required for getOrDefault operation');
      return await getOrCreateDataTableRow(tableId, String(key), buildDataObject(fields));
    }

    if (operation === 'query') {
      let qf: any = params.queryFilters;
      if (typeof qf === 'string') {
        try { qf = JSON.parse(qf || '[]'); } catch { throw new Error('Data Table Node error: queryFilters must be valid JSON'); }
      }
      if (!Array.isArray(qf)) qf = [];
      const sort = params.sortColumn
        ? { column: params.sortColumn, dir: (params.sortDir === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc' }
        : undefined;
      const limit = params.limit ? Number(params.limit) : undefined;
      return await queryDataTableRows(tableId, qf, { sort, limit });
    }

    if (operation === 'append') {
      const dataObj: Record<string, any> = {};
      for (const item of fields) {
        if (item && item.key) {
          let val = item.value;
          if (typeof val === 'string') {
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (!isNaN(Number(val)) && val.trim() !== '') val = Number(val);
          }
          dataObj[item.key] = val;
        }
      }

      const generatedRowId = `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      await addDataTableRow(tableId, generatedRowId, dataObj);
      return { id: generatedRowId, tableId, data: dataObj };
    }

    if (operation === 'search') {
      const allRows = await getDataTableRows(tableId);
      const filterObj: Record<string, any> = {};
      for (const item of filters) {
        if (item && item.key) {
          filterObj[item.key] = item.value;
        }
      }

      const filtered = allRows.filter(row => {
        for (const [key, value] of Object.entries(filterObj)) {
          if (String(row.data[key]) !== String(value)) {
            return false;
          }
        }
        return true;
      });

      return filtered;
    }

    if (operation === 'update') {
      if (!rowId) {
        throw new Error('Data Table Node error: rowId is required for update operation');
      }

      const dataObj: Record<string, any> = {};
      for (const item of fields) {
        if (item && item.key) {
          let val = item.value;
          if (typeof val === 'string') {
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (!isNaN(Number(val)) && val.trim() !== '') val = Number(val);
          }
          dataObj[item.key] = val;
        }
      }

      await updateDataTableRow(rowId, dataObj);
      return { success: true, id: rowId, updatedFields: dataObj };
    }

    if (operation === 'delete') {
      if (!rowId) {
        throw new Error('Data Table Node error: rowId is required for delete operation');
      }
      await deleteDataTableRow(rowId);
      return { success: true, id: rowId };
    }

    throw new Error(`Data Table Node error: Unsupported operation: ${operation}`);
  }
};

class NodeRegistryClass {
  private registry = new Map<string, LibreFlowNodeDefinition>();

  constructor() {
    this.register(triggerNode);
    this.register(setNode);
    this.register(httpRequestNode);
    this.register(jsCodeNode);
    this.register(ifNode);
    this.register(logNode);
    this.register(mergeNode);
    this.register(executeWorkflowNode);
    this.register(loopNode);
    this.register(mcpToolCallNode);
    this.register(dataTableNode);
  }

  register(node: LibreFlowNodeDefinition) {
    this.registry.set(node.type, node);
  }

  getNodeType(type: string): LibreFlowNodeDefinition | undefined {
    return this.registry.get(type);
  }

  getAllNodeTypes(): LibreFlowNodeDefinition[] {
    return Array.from(this.registry.values());
  }
}

export const NodeRegistry = new NodeRegistryClass();

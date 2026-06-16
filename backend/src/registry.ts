import { LibreFlowNodeDefinition } from './sdk.js';
import { WorkflowSuspendError } from './engine.js';
import { getCredentialById, getWorkflowById, getBinary } from './db.js';
import { storeBinary, isBinaryRef, fileNameFromUrl } from './binary.js';
import ivm from 'isolated-vm';
import { executeMcpToolCall } from './mcp.js';
import { assertSafeUrl, isUnsafeKey } from './security.js';
import { getOAuth2AccessToken } from './oauth2.js';

/**
 * Loads a stored credential and returns the auth to apply: headers to merge and query
 * params to append. Single source of truth for the credential→auth scheme (basicAuth →
 * Authorization: Basic; apiKey → custom header or query param; oauth2 → Authorization:
 * Bearer con token obtenido/renovado automáticamente), shared by httpRequest, mcpToolCall
 * and aiAgent.
 */
export async function resolveCredentialAuth(credentialId?: string): Promise<{ headers: Record<string, string>; query: Record<string, string> }> {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  if (!credentialId) return { headers, query };
  const cred = await getCredentialById(credentialId);
  if (!cred || !cred.data) {
    console.warn(`[Credential] Not found or failed to load: ${credentialId}`);
    return { headers, query };
  }
  if (cred.type === 'basicAuth') {
    const { user = '', password = '' } = cred.data;
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  } else if (cred.type === 'apiKey') {
    const { name = '', value = '', in: keyIn = 'header' } = cred.data;
    if (name && value) {
      if (keyIn === 'query') query[name] = value;
      else headers[name] = value;
    }
  } else if (cred.type === 'oauth2') {
    // Obtiene (o renueva) el access token. A diferencia de los otros esquemas, aquí un
    // fallo es duro: sin token la petición iría sin auth y fallaría con 401, así que
    // propagamos el error para que el nodo falle con un mensaje claro.
    const token = await getOAuth2AccessToken(cred);
    headers['Authorization'] = 'Bearer ' + token;
  }
  return { headers, query };
}

/** Appends query params to a URL string (no-op when empty). */
function appendQueryParams(url: string, query: Record<string, string>): string {
  if (Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.append(k, v);
  return u.toString();
}

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
        { label: 'Cron (Programado)', value: 'cron' },
        { label: 'Tabla de Datos (Reactivo)', value: 'dataTable' },
        { label: 'Streaming (SSE / WebSocket / MQTT / IMAP)', value: 'stream' }
      ]
    },
    {
      name: 'streamTransport',
      label: 'Transporte de streaming',
      type: 'options',
      default: 'sse',
      options: [
        { label: 'SSE (Server-Sent Events)', value: 'sse' },
        { label: 'WebSocket', value: 'websocket' },
        { label: 'MQTT', value: 'mqtt' },
        { label: 'IMAP (correo entrante)', value: 'imap' }
      ]
    },
    {
      name: 'streamUrl',
      label: 'URL (SSE / WebSocket / MQTT)',
      type: 'string',
      default: '',
      placeholder: 'https://… , wss://… , mqtt://broker:1883'
    },
    {
      name: 'mqttTopic',
      label: 'Topic MQTT',
      type: 'string',
      default: '',
      placeholder: 'sensores/temperatura'
    },
    {
      name: 'imapHost',
      label: 'IMAP: host',
      type: 'string',
      default: '',
      placeholder: 'imap.gmail.com'
    },
    {
      name: 'imapPort',
      label: 'IMAP: puerto',
      type: 'string',
      default: '993',
      placeholder: '993'
    },
    {
      name: 'imapMailbox',
      label: 'IMAP: buzón',
      type: 'string',
      default: 'INBOX',
      placeholder: 'INBOX'
    },
    {
      name: 'imapSecure',
      label: 'IMAP: TLS',
      type: 'boolean',
      default: true
    },
    {
      name: 'credentialId',
      label: 'Credencial (auth del stream)',
      type: 'options',
      default: '',
      options: [],
      description: 'SSE/WS: cabecera de auth. MQTT/IMAP: usuario/contraseña (credencial basicAuth).'
    },
    {
      name: 'tableId',
      label: 'Tabla de Datos a observar',
      type: 'options',
      default: '',
      options: []
    },
    {
      name: 'tableEvent',
      label: 'Evento que dispara',
      type: 'options',
      default: 'any',
      options: [
        { label: 'Insertar o actualizar', value: 'any' },
        { label: 'Solo al insertar', value: 'insert' },
        { label: 'Solo al actualizar', value: 'update' }
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
    },
    {
      name: 'bodyType',
      label: 'Tipo de cuerpo',
      type: 'options',
      default: 'auto',
      options: [
        { label: 'Automático (JSON / texto)', value: 'auto' },
        { label: 'Binario (subir fichero)', value: 'binary' }
      ]
    },
    {
      name: 'responseFormat',
      label: 'Formato de respuesta',
      type: 'options',
      default: 'auto',
      options: [
        { label: 'Automático (JSON / texto)', value: 'auto' },
        { label: 'JSON', value: 'json' },
        { label: 'Texto', value: 'text' },
        { label: 'Binario (descargar fichero)', value: 'binary' }
      ]
    }
  ],
  execute: async (params, _context, _inputs, execMeta) => {
    const {
      url,
      method = 'GET',
      headers = [],
      body,
      bodyType = 'auto',
      responseFormat = 'auto',
      authentication = 'none',
      credentialId
    } = params;
    const executionId = execMeta?.executionId ?? null;

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
      const auth = await resolveCredentialAuth(credentialId);
      Object.assign(headerObj, auth.headers);
      requestUrl = appendQueryParams(requestUrl, auth.query);
    }

    const fetchOptions: RequestInit = {
      method,
      headers: headerObj,
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && body) {
      if (bodyType === 'binary') {
        // Sube un fichero: `body` debe resolver a una referencia de binario; cargamos los
        // bytes del store y los enviamos como cuerpo crudo.
        if (!isBinaryRef(body)) {
          throw new Error('HTTP Request: bodyType=binary requiere que el cuerpo sea una referencia de binario (ej. {{ $node.X.output.body }}).');
        }
        const bin = await getBinary(body._lfBinary);
        if (!bin) throw new Error(`HTTP Request: binario "${body._lfBinary}" no encontrado.`);
        fetchOptions.body = new Uint8Array(bin.data);
        if (!headerObj['Content-Type'] && (body.mimeType || bin.mime_type)) {
          headerObj['Content-Type'] = body.mimeType || bin.mime_type!;
        }
      } else {
        fetchOptions.body = typeof body === 'object' ? JSON.stringify(body) : String(body);
        if (!headerObj['Content-Type']) {
          headerObj['Content-Type'] = 'application/json';
        }
      }
    }

    const response = await fetch(requestUrl, fetchOptions);

    const resHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    let responseBody: any;
    if (responseFormat === 'binary') {
      // Descarga: guarda los bytes en el store y devuelve una referencia ligera.
      const buf = Buffer.from(await response.arrayBuffer());
      const fileName = fileNameFromUrl(requestUrl);
      const mimeType = resHeaders['content-type']?.split(';')[0]?.trim();
      responseBody = await storeBinary(buf, { executionId, fileName, mimeType });
    } else {
      const text = await response.text();
      if (responseFormat === 'text') {
        responseBody = text;
      } else if (responseFormat === 'json') {
        responseBody = JSON.parse(text);
      } else {
        // auto: intenta JSON, cae a texto.
        try { responseBody = JSON.parse(text); } catch { responseBody = text; }
      }
    }

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
    // El código del usuario corre en un aislado de isolated-vm (motor V8 sin bindings al
    // host: sin require/fs/process/red). Memoria y tiempo acotados. Por eso es seguro en
    // producción y NO necesita ningún flag para habilitarse.
    const code = params.code || 'return {};';
    const timeoutMs = Math.max(50, Number(process.env.LF_JS_TIMEOUT_MS) || 5000);
    const memoryMb = Math.max(8, Number(process.env.LF_JS_MEMORY_MB) || 128);

    // El contexto (salidas de nodos previos) se inyecta como COPIA — no hay referencias
    // vivas a objetos del host, así que el código aislado no puede mutar el estado real.
    let safeContext: Record<string, any> = {};
    try {
      safeContext = JSON.parse(JSON.stringify(context ?? {}));
    } catch {
      safeContext = {};
    }

    const isolate = new ivm.Isolate({ memoryLimit: memoryMb });
    try {
      const vmContext = await isolate.createContext();
      const jail = vmContext.global;

      // Inyecta el contexto copiado y un puente de log (única referencia al host, solo
      // recibe strings y no devuelve nada al aislado).
      jail.setSync('__lfContext', new ivm.ExternalCopy(safeContext).copyInto());
      jail.setSync('__lfLog', new ivm.Reference((level: string, msg: string) => {
        const line = `[jsCode] ${msg}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
      }));

      // Envuelve el código del usuario: reconstruye `$node`/`context`/`console` DENTRO del
      // aislado (JS puro, sin host) y devuelve la promesa de `run()`.
      const wrapped = `(function () {
        const context = __lfContext;
        const __fwd = (level) => (...args) => {
          try {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            __lfLog.applyIgnored(undefined, [level, msg]);
          } catch (e) { /* logging nunca debe romper el script */ }
        };
        const console = { log: __fwd('log'), info: __fwd('info'), warn: __fwd('warn'), error: __fwd('error'), debug: __fwd('debug') };
        const $node = new Proxy({}, {
          get(target, prop) {
            if (typeof prop === 'string') return context[prop] || { output: {} };
            return undefined;
          }
        });
        const run = async () => {
          ${code}
        };
        return run();
      })()`;

      let script;
      try {
        script = await isolate.compileScript(wrapped);
      } catch (err: any) {
        throw new Error(`JS Code execution failed: ${err?.message || String(err)}`);
      }

      let result;
      try {
        result = await script.run(vmContext, { timeout: timeoutMs, promise: true, copy: true });
      } catch (err: any) {
        const m = err?.message || String(err);
        if (/script execution timed out|timed out/i.test(m)) {
          throw new Error(`JS Code execution timed out (limit: ${timeoutMs}ms)`);
        }
        if (/memory limit/i.test(m)) {
          throw new Error(`JS Code exceeded memory limit (${memoryMb}MB)`);
        }
        throw new Error(`JS Code execution failed: ${m}`);
      }

      return result === undefined ? {} : result;
    } finally {
      try { isolate.dispose(); } catch { /* ya liberado */ }
    }
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

    // Resolve auth from the encrypted credentials vault (shared helper).
    let requestUrl = serverUrl;
    let headers: Record<string, string> = {};
    if (authentication === 'genericCredential' && credentialId) {
      const auth = await resolveCredentialAuth(credentialId);
      headers = auth.headers;
      requestUrl = appendQueryParams(serverUrl, auth.query);
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

const aiAgentNode: LibreFlowNodeDefinition = {
  type: 'aiAgent',
  displayName: 'Agente IA',
  category: 'AI',
  icon: '🤖',
  description: 'Agente LLM que usa un servidor MCP como herramientas (bucle de tool-calling)',
  ui: {
    subtitle: 'Agente con herramientas',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(265, 85%, 60%), hsl(220, 85%, 55%))'
  },
  parameters: [
    {
      name: 'endpoint',
      label: 'Endpoint (OpenAI-compatible)',
      type: 'string',
      default: 'http://localhost:1234/v1',
      placeholder: 'http://localhost:1234/v1 (LM Studio), https://api.openai.com/v1, …'
    },
    {
      name: 'model',
      label: 'Modelo',
      type: 'string',
      default: '',
      placeholder: 'p.ej. qwen/qwen3-4b-2507 o gpt-4o-mini'
    },
    {
      name: 'authentication',
      label: 'Autenticación',
      type: 'options',
      default: 'none',
      options: [
        { label: 'Ninguna (LM Studio local)', value: 'none' },
        { label: 'Credencial (API Key)', value: 'genericCredential' }
      ]
    },
    {
      name: 'credentialId',
      label: 'Credencial del LLM',
      type: 'options',
      default: ''
    },
    {
      name: 'systemPrompt',
      label: 'System Prompt',
      type: 'code',
      default: 'Eres un asistente que cumple la tarea del usuario usando las herramientas disponibles. Responde de forma breve cuando termines.'
    },
    {
      name: 'userMessage',
      label: 'Mensaje / Tarea',
      type: 'string',
      default: '',
      placeholder: 'La tarea para el agente (admite expresiones {{ $node.X.output... }})'
    },
    {
      name: 'mcpServerId',
      label: 'Servidor MCP propio (herramientas)',
      type: 'options',
      default: '',
      options: []
    },
    {
      name: 'mcpServerUrl',
      label: 'Servidor MCP externo (URL)',
      type: 'string',
      default: '',
      placeholder: 'Opcional. Tiene prioridad sobre el servidor propio. Streamable HTTP o SSE.'
    },
    {
      name: 'mcpAuthentication',
      label: 'Auth del servidor MCP externo',
      type: 'options',
      default: 'none',
      options: [
        { label: 'Ninguna', value: 'none' },
        { label: 'Credencial (API Key)', value: 'genericCredential' }
      ]
    },
    {
      name: 'mcpCredentialId',
      label: 'Credencial del servidor MCP',
      type: 'options',
      default: ''
    },
    {
      name: 'maxIterations',
      label: 'Máx. iteraciones',
      type: 'string',
      default: '5'
    },
    {
      name: 'temperature',
      label: 'Temperatura',
      type: 'string',
      default: '0'
    },
    {
      name: 'timeoutMs',
      label: 'Timeout por llamada al LLM (ms)',
      type: 'string',
      default: '120000'
    }
  ],
  execute: async (params) => {
    const {
      endpoint = 'http://localhost:1234/v1',
      model,
      authentication = 'none',
      credentialId,
      systemPrompt,
      userMessage,
      mcpServerId,
      mcpServerUrl,
      mcpAuthentication = 'none',
      mcpCredentialId,
      maxIterations = '5',
      temperature = '0',
      timeoutMs = '120000'
    } = params;

    if (!model) throw new Error('AI Agent error: model is required');
    if (!userMessage) throw new Error('AI Agent error: userMessage is required');

    // SSRF guard on the LLM endpoint (private IPs blocked in production, allowed in dev).
    await assertSafeUrl(endpoint);

    // LLM auth from the encrypted credentials vault (shared helper).
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let llmEndpoint = endpoint;
    if (authentication === 'genericCredential' && credentialId) {
      const auth = await resolveCredentialAuth(credentialId);
      Object.assign(headers, auth.headers);
      llmEndpoint = appendQueryParams(endpoint, auth.query);
    }

    const toOpenAI = (tools: any[]) => tools.map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
    }));

    // Toolset resolution. Two modes:
    //  - External MCP server (URL): via the SDK client, optionally authenticated.
    //  - Own named MCP server (id): IN-PROCESS via dispatchMcpRpc (no HTTP, no auth).
    // `callTool(name, args)` abstracts the dispatch for the loop below.
    let openaiTools: any[] = [];
    let callTool: ((name: string, args: any) => Promise<string>) | null = null;
    let mcpSession: { close: () => void } | null = null;

    if (mcpServerUrl) {
      // External MCP: auth from the vault, ONE persistent client session reused across the
      // loop (avoids a connect+initialize handshake per tool call).
      const mcpAuth = (mcpAuthentication === 'genericCredential' && mcpCredentialId)
        ? await resolveCredentialAuth(mcpCredentialId)
        : { headers: {}, query: {} };
      const url = appendQueryParams(mcpServerUrl, mcpAuth.query);
      const { openMcpClientSession } = await import('./mcp.js');
      const session = await openMcpClientSession(url, mcpAuth.headers);
      mcpSession = session;
      openaiTools = toOpenAI(await session.listTools());
      callTool = async (name, args) => {
        const result: any = await session.callTool(name, args);
        return result?.content?.[0]?.text ?? JSON.stringify(result ?? {});
      };
    } else if (mcpServerId) {
      const { dispatchMcpRpc } = await import('./mcp.js');
      const { getMcpServerById } = await import('./db.js');
      const server = await getMcpServerById(mcpServerId);
      if (!server) throw new Error(`AI Agent error: MCP server "${mcpServerId}" not found`);
      const scope = { workflowIds: server.workflow_ids, exposeSystemTools: server.expose_system_tools };
      const listed = await dispatchMcpRpc({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, scope);
      openaiTools = toOpenAI(listed.payload?.result?.tools || []);
      callTool = async (name, args) => {
        const r = await dispatchMcpRpc({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name, arguments: args } }, scope);
        if (r.payload?.error) return 'error: ' + r.payload.error.message;
        return r.payload?.result?.content?.[0]?.text ?? JSON.stringify(r.payload?.result ?? {});
      };
    }

    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(userMessage) });

    const maxIter = Math.max(1, Math.min(20, Number(maxIterations) || 5));
    const temp = Number(temperature);
    const llmTimeout = Math.max(5000, Number(timeoutMs) || 120000);
    const trace: any[] = [];
    let answer = '';
    let hitCap = true;

    const chatUrl = `${llmEndpoint.replace(/\/$/, '')}/chat/completions`;

    try {
    for (let i = 0; i < maxIter; i++) {
      const body: any = { model, messages, temperature: isNaN(temp) ? 0 : temp, stream: false };
      if (openaiTools.length) { body.tools = openaiTools; body.tool_choice = 'auto'; }

      // Abort a hung LLM call instead of blocking the workflow. The timer stays armed
      // through the body read (a server can send headers then stall the stream).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), llmTimeout);
      let data: any;
      try {
        const res = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`AI Agent LLM error: HTTP ${res.status} ${t.slice(0, 200)}`);
        }
        data = await res.json();
      } catch (err: any) {
        if (err?.name === 'AbortError') throw new Error(`AI Agent error: LLM call timed out after ${llmTimeout}ms`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('AI Agent error: no message in LLM response');

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        answer = msg.content || '';
        hitCap = false;
        break;
      }

      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty */ }
        let resultText = '';
        try {
          resultText = callTool ? await callTool(tc.function.name, args) : 'error: no toolset configured';
        } catch (e: any) {
          resultText = 'error: ' + e.message;
        }
        trace.push({ tool: tc.function.name, arguments: args, result: resultText.slice(0, 2000) });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(resultText).slice(0, 4000) });
      }
    }
    } finally {
      mcpSession?.close();
    }

    return { answer, iterations: trace.length, hitMaxIterations: hitCap && trace.length > 0, toolCalls: trace };
  }
};

const waitNode: LibreFlowNodeDefinition = {
  type: 'wait',
  displayName: 'Esperar / Reanudar',
  category: 'Flow',
  icon: '⏸',
  description: 'Suspende el flujo hasta que algo externo lo reanuda (POST /hooks/resume/<token>). El payload de resume queda como output de este nodo.',
  ui: {
    subtitle: 'Pausa hasta resume',
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    gradient: 'linear-gradient(135deg, hsl(45, 90%, 55%), hsl(25, 90%, 50%))'
  },
  parameters: [
    {
      name: 'resumeMode',
      label: 'Modo de reanudación',
      type: 'options',
      default: 'webhook',
      options: [
        { label: 'Webhook (reanudar vía URL con token)', value: 'webhook' }
      ]
    }
  ],
  // The engine intercepts this signal: it persists the partial run and returns a
  // `suspended` report with a resume token. On resume, the engine supplies the output.
  execute: async () => { throw new WorkflowSuspendError(); }
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
    this.register(aiAgentNode);
    this.register(waitNode);
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

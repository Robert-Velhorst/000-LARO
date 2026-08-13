import { ENV } from "./_core/env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  provider?: LLMProvider;
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export const EXTERNAL_LLM_PROVIDERS = [
  "forge",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "groq",
  "together",
] as const;

export type LLMProvider = typeof EXTERNAL_LLM_PROVIDERS[number];

export type LLMProviderDescriptor = {
  id: LLMProvider;
  label: string;
  model: string;
  configured: boolean;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

type ProviderConfig = LLMProviderDescriptor & {
  apiKey: string;
  url: string;
  keyName: string;
  nativeAnthropic?: boolean;
  jsonSchema?: boolean;
};

function providerConfigs(): Record<LLMProvider, ProviderConfig> {
  const forgeKey = process.env.FORGE_API_KEY || ENV.forgeApiKey;
  const forgeBase = (process.env.FORGE_API_URL || ENV.forgeApiUrl || "https://forge.manus.im").replace(/\/$/, "");
  const openaiKey = process.env.OPENAI_API_KEY || ENV.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY || ENV.ANTHROPIC_API_KEY;
  const googleKey = process.env.GOOGLE_GEMINI_API_KEY || ENV.GOOGLE_GEMINI_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY || ENV.DEEPSEEK_API_KEY;
  const groqKey = process.env.GROQ_API_KEY || ENV.GROQ_API_KEY;
  const togetherKey = process.env.TOGETHER_API_KEY || ENV.TOGETHER_API_KEY;
  return {
    forge: {
      id: "forge", label: "Forge-compatible", apiKey: forgeKey, keyName: "FORGE_API_KEY",
      model: process.env.LARO_FORGE_MODEL || "gemini-2.5-flash", url: `${forgeBase}/v1/chat/completions`, configured: Boolean(forgeKey), jsonSchema: true,
    },
    openai: {
      id: "openai", label: "OpenAI", apiKey: openaiKey, keyName: "OPENAI_API_KEY",
      model: process.env.LARO_OPENAI_MODEL || "gpt-5.4-mini", url: "https://api.openai.com/v1/chat/completions", configured: Boolean(openaiKey), jsonSchema: true,
    },
    anthropic: {
      id: "anthropic", label: "Anthropic", apiKey: anthropicKey, keyName: "ANTHROPIC_API_KEY",
      model: process.env.LARO_ANTHROPIC_MODEL || "claude-sonnet-5", url: "https://api.anthropic.com/v1/messages", configured: Boolean(anthropicKey), nativeAnthropic: true,
    },
    google: {
      id: "google", label: "Google Gemini", apiKey: googleKey, keyName: "GOOGLE_GEMINI_API_KEY",
      model: process.env.LARO_GOOGLE_MODEL || "gemini-3.6-flash", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", configured: Boolean(googleKey), jsonSchema: true,
    },
    deepseek: {
      id: "deepseek", label: "DeepSeek", apiKey: deepseekKey, keyName: "DEEPSEEK_API_KEY",
      model: process.env.LARO_DEEPSEEK_MODEL || "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", configured: Boolean(deepseekKey),
    },
    groq: {
      id: "groq", label: "Groq", apiKey: groqKey, keyName: "GROQ_API_KEY",
      model: process.env.LARO_GROQ_MODEL || "openai/gpt-oss-120b", url: "https://api.groq.com/openai/v1/chat/completions", configured: Boolean(groqKey),
    },
    together: {
      id: "together", label: "Together AI", apiKey: togetherKey, keyName: "TOGETHER_API_KEY",
      model: process.env.LARO_TOGETHER_MODEL || "meta-llama/Llama-3.3-70B-Instruct-Turbo", url: "https://api.together.ai/v1/chat/completions", configured: Boolean(togetherKey), jsonSchema: true,
    },
  };
}

export function getLLMProviderDescriptors(): LLMProviderDescriptor[] {
  const configs = providerConfigs();
  return EXTERNAL_LLM_PROVIDERS.map((id) => {
    const { label, model, configured } = configs[id];
    return { id, label, model, configured };
  });
}

export function isLLMProviderConfigured(provider: LLMProvider): boolean {
  return providerConfigs()[provider].configured;
}

function getProviderConfig(provider: LLMProvider): ProviderConfig {
  const config = providerConfigs()[provider];
  if (!config.apiKey) {
    throw new Error(`${config.keyName} is not configured; ${config.label} analysis is unavailable`);
  }
  return config;
}

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

function textOnlyContent(content: Message["content"]): string {
  return ensureArray(content).map((part) => {
    if (typeof part === "string") return part;
    if (part.type === "text") return part.text;
    throw new Error("Anthropic adapter currently supports text messages only");
  }).join("\n");
}

function schemaInstruction(format: ReturnType<typeof normalizeResponseFormat>): string | null {
  if (!format || format.type === "text") return null;
  if (format.type === "json_object") return "Return one valid JSON object and no surrounding prose.";
  return `Return one JSON object matching this JSON Schema and no surrounding prose:\n${JSON.stringify(format.json_schema.schema)}`;
}

async function invokeAnthropic(config: ProviderConfig, params: InvokeParams): Promise<InvokeResult> {
  const format = normalizeResponseFormat(params);
  const systems = params.messages
    .filter((message) => message.role === "system")
    .map((message) => textOnlyContent(message.content));
  const formatPrompt = schemaInstruction(format);
  if (formatPrompt) systems.push(formatPrompt);
  const messages = params.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: textOnlyContent(message.content) }));
  const payload: Record<string, unknown> = {
    model: config.model,
    max_tokens: params.maxTokens || params.max_tokens || 4096,
    messages,
  };
  if (systems.length) payload.system = systems.join("\n\n");
  if (params.tools?.length) {
    payload.tools = params.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || { type: "object", properties: {} },
    }));
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed (${config.label}): ${response.status} ${response.statusText} - ${errorText}`);
  }
  const result = await response.json() as {
    id: string;
    model: string;
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content = result.content || [];
  const responseText = content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
  const toolCalls = content.filter((part) => part.type === "tool_use").map((part) => ({
    id: part.id || "",
    type: "function" as const,
    function: { name: part.name || "", arguments: JSON.stringify(part.input || {}) },
  }));
  const promptTokens = result.usage?.input_tokens || 0;
  const completionTokens = result.usage?.output_tokens || 0;
  return {
    id: result.id,
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: responseText, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: result.stop_reason || null,
    }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const provider = params.provider || "forge";
  const config = getProviderConfig(provider);
  if (config.nativeAnthropic) return invokeAnthropic(config, params);

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
  } = params;

  const payload: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  const tokenLimit = params.maxTokens || params.max_tokens || 32768;
  if (provider === "openai") payload.max_completion_tokens = tokenLimit;
  else payload.max_tokens = tokenLimit;

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat.type === "json_schema" && !config.jsonSchema
      ? { type: "json_object" }
      : normalizedResponseFormat;
  }

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed (${config.label}): ${response.status} ${response.statusText} - ${errorText}`);
  }

  return (await response.json()) as InvokeResult;
}

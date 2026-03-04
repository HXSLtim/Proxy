import http from "node:http";
import { TextDecoder } from "node:util";

function normalizeResponsesTarget(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "messages" || v === "anthropic" || v === "anthropic_messages" || v === "v1/messages") return "messages";
  if (v === "responses" || v === "openai" || v === "v1/responses") return "responses";
  return "chat";
}

function normalizeReasoningEffort(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
  return "";
}

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-4.1-mini";
const FORCE_MODEL_ID = String(process.env.FORCE_MODEL_ID || process.env.FIXED_MODEL_ID || process.env.FIXED_MODEL || "").trim();
const FORCE_REASONING_EFFORT = normalizeReasoningEffort(
  process.env.FORCE_REASONING_EFFORT ||
    process.env.MODEL_REASONING_EFFORT ||
    process.env.FIXED_REASONING_EFFORT ||
    process.env.THINKING_LEVEL ||
    "",
);

const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || `${OPENAI_BASE_URL}/responses`;

const RESPONSES_TARGET = normalizeResponsesTarget(process.env.RESPONSES_TARGET || "responses");
const CHAT_BASE_URL = (process.env.CHAT_BASE_URL || OPENAI_BASE_URL).replace(/\/+$/, "");
const CHAT_API_KEY = process.env.CHAT_API_KEY || OPENAI_API_KEY;
const CHAT_COMPLETIONS_URL = process.env.CHAT_COMPLETIONS_URL || `${CHAT_BASE_URL}/chat/completions`;
const RESPONSES_UPSTREAM_URL = process.env.RESPONSES_UPSTREAM_URL || OPENAI_RESPONSES_URL;
const RESPONSES_API_KEY = process.env.RESPONSES_API_KEY || CHAT_API_KEY || OPENAI_API_KEY;
const RESPONSES_MODELS_URL =
  process.env.RESPONSES_MODELS_URL ||
  (RESPONSES_UPSTREAM_URL.endsWith("/responses") ? RESPONSES_UPSTREAM_URL.replace(/\/responses$/, "/models") : `${OPENAI_BASE_URL}/models`);

const MESSAGES_BASE_URL = (process.env.MESSAGES_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(
  /\/+$/,
  "",
);
const MESSAGES_API_KEY = process.env.MESSAGES_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const MESSAGES_URL = process.env.MESSAGES_URL || `${MESSAGES_BASE_URL}/messages`;
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || "2023-06-01";
const DEFAULT_MESSAGES_MAX_TOKENS = Number(process.env.DEFAULT_MESSAGES_MAX_TOKENS || 1024);
const MESSAGES_THINKING_BUDGET_LOW = Number(process.env.MESSAGES_THINKING_BUDGET_LOW || 1024);
const MESSAGES_THINKING_BUDGET_MEDIUM = Number(process.env.MESSAGES_THINKING_BUDGET_MEDIUM || 4096);
const MESSAGES_THINKING_BUDGET_HIGH = Number(process.env.MESSAGES_THINKING_BUDGET_HIGH || 8192);
const MESSAGES_THINKING_BUDGET_XHIGH = Number(process.env.MESSAGES_THINKING_BUDGET_XHIGH || 16384);

function writeJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function createError(status, message, type = "invalid_request_error") {
  return {
    error: {
      message,
      type,
      code: null,
      param: null,
    },
    status,
  };
}

function createAnthropicError(message, type = "invalid_request_error") {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function sanitizeCodexCompatPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out = { ...payload };

  // Codex-side config flags are not upstream API fields; strip to avoid strict upstream rejection.
  delete out.network_access;
  delete out.windows_wsl_setup_acknowledged;
  delete out.model_verbosity;
  delete out.model_provider;

  // Codex compatibility alias -> OpenAI responses flag.
  if (typeof out.disable_response_storage === "boolean") {
    if (out.disable_response_storage === true) {
      out.store = false;
    } else if (typeof out.store !== "boolean") {
      out.store = true;
    }
  }
  delete out.disable_response_storage;

  // Codex compatibility alias -> responses reasoning structure.
  if (typeof out.model_reasoning_effort === "string") {
    const effort = normalizeReasoningEffort(out.model_reasoning_effort);
    if (effort) {
      const reasoning =
        out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning) ? { ...out.reasoning } : {};
      reasoning.effort = effort;
      out.reasoning = reasoning;
    }
  }
  delete out.model_reasoning_effort;

  return out;
}

function pickModel(requestedModel) {
  if (FORCE_MODEL_ID) return FORCE_MODEL_ID;
  if (typeof requestedModel === "string" && requestedModel.trim().length > 0) return requestedModel;
  return DEFAULT_MODEL;
}

function getMessagesThinkingBudgetByEffort(effort) {
  if (effort === "low") return MESSAGES_THINKING_BUDGET_LOW;
  if (effort === "high") return MESSAGES_THINKING_BUDGET_HIGH;
  if (effort === "xhigh") return MESSAGES_THINKING_BUDGET_XHIGH;
  return MESSAGES_THINKING_BUDGET_MEDIUM;
}

function applyForcedSettings(payload, target) {
  if (!payload || typeof payload !== "object") return payload;

  payload.model = pickModel(payload.model);

  if (!FORCE_REASONING_EFFORT) return payload;

  if (target === "responses") {
    const reasoning =
      payload.reasoning && typeof payload.reasoning === "object" && !Array.isArray(payload.reasoning)
        ? { ...payload.reasoning }
        : {};
    reasoning.effort = FORCE_REASONING_EFFORT;
    payload.reasoning = reasoning;
    return payload;
  }

  if (target === "chat") {
    payload.reasoning_effort = FORCE_REASONING_EFFORT;
    return payload;
  }

  if (target === "messages") {
    const budgetTokens = getMessagesThinkingBudgetByEffort(FORCE_REASONING_EFFORT);
    if (Number.isFinite(budgetTokens) && budgetTokens > 0) {
      payload.thinking = {
        type: "enabled",
        budget_tokens: Math.floor(budgetTokens),
      };
    }
    return payload;
  }

  return payload;
}

function stringifyUnknown(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function textFromUnknownContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const chunks = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
    return chunks.join("");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function normalizeMessageContent(content, role) {
  if (typeof content === "string") {
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  }
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = part.type;
      if (type === "text") {
        out.push({ type: role === "assistant" ? "output_text" : "input_text", text: String(part.text || "") });
      } else if (type === "input_text" || type === "output_text") {
        out.push({ type, text: String(part.text || "") });
      }
    }
    return out;
  }
  return [{ type: role === "assistant" ? "output_text" : "input_text", text: "" }];
}

function chatMessagesToResponsesInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role || "user";

    if (role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        if (!tc || tc.type !== "function" || !tc.function) continue;
        out.push({
          type: "function_call",
          call_id: tc.id || "",
          name: tc.function.name,
          arguments: tc.function.arguments || "{}",
        });
      }
      if (msg.content) {
        out.push({
          role: "assistant",
          content: normalizeMessageContent(msg.content, "assistant"),
        });
      }
      continue;
    }

    out.push({
      role,
      content: normalizeMessageContent(msg.content, role),
    });
  }
  return out;
}

function chatToolsToResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || tool.type !== "function" || !tool.function) continue;
    out.push({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters || { type: "object", properties: {} },
      strict: Boolean(tool.function.strict),
    });
  }
  return out.length ? out : undefined;
}

function chatToolChoiceToResponses(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return { type: "function", name: toolChoice.function.name };
  }
  return undefined;
}

function chatResponseFormatToResponsesText(responseFormat) {
  if (!responseFormat || typeof responseFormat !== "object") return undefined;
  if (responseFormat.type === "json_schema" && responseFormat.json_schema) {
    const schema = responseFormat.json_schema;
    return {
      format: {
        type: "json_schema",
        name: schema.name || "response",
        schema: schema.schema || {},
        strict: Boolean(schema.strict),
      },
    };
  }
  if (responseFormat.type === "json_object") {
    return {
      format: {
        type: "json_schema",
        name: "json_object",
        schema: {
          type: "object",
          additionalProperties: true,
        },
        strict: false,
      },
    };
  }
  return undefined;
}

function chatRequestToResponsesPayload(body) {
  const model = pickModel(body.model);
  const payload = {
    model,
    input: chatMessagesToResponsesInput(body.messages),
  };

  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (typeof body.presence_penalty === "number") payload.presence_penalty = body.presence_penalty;
  if (typeof body.frequency_penalty === "number") payload.frequency_penalty = body.frequency_penalty;

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxTokens === "number") payload.max_output_tokens = maxTokens;

  const tools = chatToolsToResponsesTools(body.tools);
  if (tools) payload.tools = tools;

  const toolChoice = chatToolChoiceToResponses(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  const text = chatResponseFormatToResponsesText(body.response_format);
  if (text) payload.text = text;

  if (body.stream === true) payload.stream = true;
  return applyForcedSettings(payload, "responses");
}

function extractAssistantTextFromResponse(resp) {
  const chunks = [];

  if (typeof resp.output_text === "string" && resp.output_text.length > 0) {
    chunks.push(resp.output_text);
  }

  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (!item || item.type !== "message" || item.role !== "assistant") continue;
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (typeof part.text === "string" && part.text.length > 0) chunks.push(part.text);
      }
    }
  }

  return chunks.join("");
}

function extractToolCallsFromResponse(resp) {
  const toolCalls = [];
  if (!Array.isArray(resp.output)) return toolCalls;

  let idx = 0;
  for (const item of resp.output) {
    if (!item || item.type !== "function_call") continue;
    toolCalls.push({
      id: item.call_id || `call_${idx + 1}`,
      type: "function",
      function: {
        name: item.name || "",
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      },
      index: idx,
    });
    idx += 1;
  }
  return toolCalls;
}

function mapFinishReason(resp, hasToolCalls) {
  if (hasToolCalls) return "tool_calls";
  if (resp.status === "incomplete") return "length";
  return "stop";
}

function responsesToChatCompletion(resp, fallbackModel) {
  const toolCalls = extractToolCallsFromResponse(resp);
  const content = extractAssistantTextFromResponse(resp);
  const id = resp.id ? `chatcmpl_${resp.id}` : `chatcmpl_${Date.now()}`;
  const created = Number(resp.created_at || Math.floor(Date.now() / 1000));
  const model = resp.model || fallbackModel || DEFAULT_MODEL;

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || (toolCalls.length ? null : ""),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapFinishReason(resp, toolCalls.length > 0),
      },
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: resp.usage?.total_tokens ?? 0,
    },
  };
}

function responsesInputToChatMessages(input, instructions) {
  const messages = [];
  let callIndex = 0;

  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "developer", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "function_call_output") {
      const callId = item.call_id || item.id || `call_${callIndex + 1}`;
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: stringifyUnknown(item.output ?? ""),
      });
      callIndex += 1;
      continue;
    }

    if (item.type === "function_call") {
      const callId = item.call_id || item.id || `call_${callIndex + 1}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: item.name || "",
              arguments: typeof item.arguments === "string" ? item.arguments : stringifyUnknown(item.arguments ?? {}),
            },
          },
        ],
      });
      callIndex += 1;
      continue;
    }

    messages.push({
      role: item.role || "user",
      content: textFromUnknownContent(item.content),
    });
  }

  return messages;
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || tool.type !== "function" || !tool.name) continue;
    out.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function responsesToolChoiceToChat(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.name) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }
  return undefined;
}

function responsesTextToChatResponseFormat(textConfig) {
  if (!textConfig || typeof textConfig !== "object") return undefined;
  const format = textConfig.format;
  if (!format || typeof format !== "object") return undefined;

  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name || "response",
        schema: format.schema || {},
        strict: Boolean(format.strict),
      },
    };
  }
  return undefined;
}

function responsesRequestToChatPayload(body) {
  const payload = {
    model: pickModel(body.model),
    messages: responsesInputToChatMessages(body.input, body.instructions),
  };

  if (!payload.messages.length) {
    payload.messages.push({ role: "user", content: "" });
  }

  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (typeof body.presence_penalty === "number") payload.presence_penalty = body.presence_penalty;
  if (typeof body.frequency_penalty === "number") payload.frequency_penalty = body.frequency_penalty;
  if (typeof body.max_output_tokens === "number") payload.max_tokens = body.max_output_tokens;

  const tools = responsesToolsToChatTools(body.tools);
  if (tools) payload.tools = tools;

  const toolChoice = responsesToolChoiceToChat(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  const responseFormat = responsesTextToChatResponseFormat(body.text);
  if (responseFormat) payload.response_format = responseFormat;

  return applyForcedSettings(payload, "chat");
}

function chatCompletionToResponses(resp, fallbackModel) {
  const choice = Array.isArray(resp.choices) && resp.choices.length > 0 ? resp.choices[0] : {};
  const msg = choice?.message || {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const text = textFromUnknownContent(msg.content);

  const output = [];
  if (text.length > 0 || toolCalls.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    });
  }

  let idx = 0;
  for (const tc of toolCalls) {
    if (!tc || tc.type !== "function" || !tc.function) continue;
    const callId = tc.id || `call_${idx + 1}`;
    output.push({
      type: "function_call",
      id: callId,
      call_id: callId,
      name: tc.function.name || "",
      arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : stringifyUnknown(tc.function.arguments ?? {}),
      status: "completed",
    });
    idx += 1;
  }

  const status = choice?.finish_reason === "length" ? "incomplete" : "completed";
  const out = {
    id: resp.id ? `resp_${resp.id}` : `resp_${Date.now()}`,
    object: "response",
    created_at: Number(resp.created || Math.floor(Date.now() / 1000)),
    status,
    model: resp.model || fallbackModel || DEFAULT_MODEL,
    output,
    output_text: text,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      total_tokens: resp.usage?.total_tokens ?? 0,
    },
  };
  if (status === "incomplete") {
    out.incomplete_details = { reason: "max_output_tokens" };
  }
  return out;
}

function parseToolArgumentsToObject(rawArgs) {
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) return rawArgs;
  if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
    const parsed = safeJsonParse(rawArgs, {});
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }
  return {};
}

function responsesInputToMessages(input) {
  const messages = [];
  let callIndex = 0;

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "function_call_output") {
      const callId = item.call_id || item.id || `call_${callIndex + 1}`;
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: callId,
            content: stringifyUnknown(item.output ?? ""),
          },
        ],
      });
      callIndex += 1;
      continue;
    }

    if (item.type === "function_call") {
      const callId = item.call_id || item.id || `call_${callIndex + 1}`;
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: callId,
            name: item.name || "",
            input: parseToolArgumentsToObject(item.arguments),
          },
        ],
      });
      callIndex += 1;
      continue;
    }

    const role = item.role === "assistant" ? "assistant" : "user";
    messages.push({
      role,
      content: textFromUnknownContent(item.content),
    });
  }
  return messages;
}

function responsesToolsToMessagesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || tool.type !== "function" || !tool.name) continue;
    out.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters || { type: "object", properties: {} },
    });
  }
  return out.length ? out : undefined;
}

function responsesToolChoiceToMessages(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") {
    if (toolChoice === "required") return { type: "any" };
    if (toolChoice === "auto") return { type: "auto" };
    if (toolChoice === "none") return null;
    return undefined;
  }
  if (toolChoice.type === "function" && toolChoice.name) {
    return { type: "tool", name: toolChoice.name };
  }
  return undefined;
}

function responsesRequestToMessagesPayload(body) {
  const payload = {
    model: pickModel(body.model),
    messages: responsesInputToMessages(body.input),
    max_tokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : DEFAULT_MESSAGES_MAX_TOKENS,
  };

  if (!payload.messages.length) {
    payload.messages.push({ role: "user", content: "" });
  }

  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    payload.system = body.instructions;
  }

  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;

  const mappedToolChoice = responsesToolChoiceToMessages(body.tool_choice);
  if (mappedToolChoice !== null) {
    const tools = responsesToolsToMessagesTools(body.tools);
    if (tools) payload.tools = tools;
    if (mappedToolChoice) payload.tool_choice = mappedToolChoice;
  }

  return applyForcedSettings(payload, "messages");
}

function messagesToResponses(resp, fallbackModel) {
  const output = [];
  let outputText = "";
  let callIndex = 0;
  const contentBlocks = Array.isArray(resp.content) ? resp.content : [];

  for (const part of contentBlocks) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text") {
      const text = String(part.text || "");
      outputText += text;
      output.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      });
      continue;
    }

    if (part.type === "tool_use") {
      const callId = part.id || `call_${callIndex + 1}`;
      output.push({
        type: "function_call",
        id: callId,
        call_id: callId,
        name: part.name || "",
        arguments: stringifyUnknown(part.input ?? {}),
        status: "completed",
      });
      callIndex += 1;
    }
  }

  if (!output.length) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "" }],
    });
  }

  const status = resp.stop_reason === "max_tokens" ? "incomplete" : "completed";
  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const out = {
    id: resp.id ? `resp_${resp.id}` : `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: resp.model || fallbackModel || DEFAULT_MODEL,
    output,
    output_text: outputText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
  if (status === "incomplete") {
    out.incomplete_details = { reason: "max_output_tokens" };
  }
  return out;
}

function anthropicSystemToInstructions(systemValue) {
  if (typeof systemValue === "string") return systemValue;
  if (Array.isArray(systemValue)) {
    const chunks = [];
    for (const part of systemValue) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
    }
    return chunks.join("\n");
  }
  return "";
}

function anthropicContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromUnknownContent(content);
  const chunks = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") chunks.push(block.text);
  }
  return chunks.join("");
}

function anthropicMessagesToResponsesInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const out = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;

    if (Array.isArray(content)) {
      const textChunks = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;

        if (block.type === "text" && typeof block.text === "string") {
          textChunks.push(block.text);
          continue;
        }

        if (block.type === "tool_result" && role === "user") {
          const callId = block.tool_use_id || block.id || "";
          const outputText = anthropicContentToText(block.content);
          out.push({
            type: "function_call_output",
            call_id: callId,
            output: outputText,
          });
          continue;
        }

        if (block.type === "tool_use" && role === "assistant") {
          const callId = block.id || block.call_id || "";
          out.push({
            type: "function_call",
            call_id: callId,
            name: block.name || "",
            arguments: stringifyUnknown(block.input ?? {}),
          });
        }
      }

      if (textChunks.length > 0) {
        out.push({
          role,
          content: normalizeMessageContent(textChunks.join(""), role),
        });
      }
      continue;
    }

    out.push({
      role,
      content: normalizeMessageContent(anthropicContentToText(content), role),
    });
  }

  return out;
}

function anthropicToolsToResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || !tool.name) continue;
    out.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: "object", properties: {} },
    });
  }
  return out.length ? out : undefined;
}

function anthropicToolChoiceToResponses(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  const type = toolChoice.type;
  if (type === "auto") return "auto";
  if (type === "any") return "required";
  if (type === "none") return "none";
  if (type === "tool" && toolChoice.name) {
    return { type: "function", name: toolChoice.name };
  }
  return undefined;
}

function anthropicMessagesRequestToResponsesPayload(body) {
  const payload = {
    model: pickModel(body.model),
    input: anthropicMessagesToResponsesInput(body.messages),
  };

  if (typeof body.max_tokens === "number") payload.max_output_tokens = body.max_tokens;
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (body.stream === true) payload.stream = true;

  const instructions = anthropicSystemToInstructions(body.system);
  if (instructions) payload.instructions = instructions;

  const tools = anthropicToolsToResponsesTools(body.tools);
  if (tools) payload.tools = tools;

  const toolChoice = anthropicToolChoiceToResponses(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  return applyForcedSettings(sanitizeCodexCompatPayload(payload), "responses");
}

function responsesToAnthropicMessage(resp, fallbackModel) {
  const content = [];
  let sawToolUse = false;
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (!item || typeof item !== "object") continue;

      if (item.type === "message" && item.role === "assistant") {
        const text = textFromUnknownContent(item.content);
        if (text.length > 0) {
          content.push({ type: "text", text });
        }
        continue;
      }

      if (item.type === "function_call") {
        sawToolUse = true;
        content.push({
          type: "tool_use",
          id: item.call_id || item.id || `toolu_${content.length + 1}`,
          name: item.name || "",
          input: parseToolArgumentsToObject(item.arguments),
        });
      }
    }
  }

  if (!content.length) {
    const fallbackText = typeof resp.output_text === "string" ? resp.output_text : "";
    content.push({ type: "text", text: fallbackText });
  }

  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  let stopReason = "end_turn";
  if (resp.status === "incomplete") stopReason = "max_tokens";
  else if (resp.status === "failed") stopReason = "error";
  else if (sawToolUse) stopReason = "tool_use";

  return {
    id: resp.id ? `msg_${resp.id}` : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp.model || fallbackModel || DEFAULT_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

async function streamResponsesAsMessagesEvents(upstreamResponse, downstreamRes, fallbackModel) {
  openSseResponse(downstreamRes);
  const outputIndexToBlockIndex = new Map();
  let nextBlockIndex = 0;
  let messageStarted = false;
  let messageId = `msg_${Date.now()}`;
  let model = fallbackModel || DEFAULT_MODEL;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawToolUse = false;
  let finalized = false;

  const emitMessageStart = (responseObj) => {
    if (messageStarted) return;
    if (responseObj && typeof responseObj === "object") {
      if (typeof responseObj.id === "string" && responseObj.id.length > 0) messageId = `msg_${responseObj.id}`;
      if (typeof responseObj.model === "string" && responseObj.model.length > 0) model = responseObj.model;
      if (typeof responseObj?.usage?.input_tokens === "number") inputTokens = responseObj.usage.input_tokens;
    }

    writeSseEvent(downstreamRes, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
        },
      },
    });
    messageStarted = true;
  };

  await forEachSseEvent(upstreamResponse, async ({ event, data, done }) => {
    if (done) return;
    if (!data || typeof data !== "object") return;

    const eventName = event || data.type || "";
    if (eventName === "error" || data.type === "error" || data.error) {
      emitMessageStart(data.response);
      const err = data.error && typeof data.error === "object" ? data.error : { type: "api_error", message: "Upstream stream error" };
      writeSseEvent(downstreamRes, "error", {
        type: "error",
        error: {
          type: err.type || "api_error",
          message: err.message || "Upstream stream error",
        },
      });
      finalized = true;
      return;
    }

    if (eventName === "response.created") {
      emitMessageStart(data.response);
      return;
    }

    emitMessageStart(data.response);

    if (eventName === "response.output_item.added") {
      const outIdx = typeof data.output_index === "number" ? data.output_index : nextBlockIndex;
      const item = data.item && typeof data.item === "object" ? data.item : {};
      const blockIndex = nextBlockIndex;
      nextBlockIndex += 1;
      outputIndexToBlockIndex.set(outIdx, blockIndex);

      if (item.type === "function_call") {
        sawToolUse = true;
        writeSseEvent(downstreamRes, "content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: item.call_id || item.id || `toolu_${blockIndex + 1}`,
            name: item.name || "",
            input: parseToolArgumentsToObject(item.arguments),
          },
        });
      } else {
        writeSseEvent(downstreamRes, "content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "text",
            text: "",
          },
        });
      }
      return;
    }

    if (eventName === "response.output_text.delta") {
      const outIdx = typeof data.output_index === "number" ? data.output_index : 0;
      const blockIndex = outputIndexToBlockIndex.get(outIdx) ?? outIdx;
      const textDelta = typeof data.delta === "string" ? data.delta : "";
      if (textDelta.length > 0) {
        writeSseEvent(downstreamRes, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "text_delta",
            text: textDelta,
          },
        });
      }
      return;
    }

    if (eventName === "response.function_call_arguments.delta") {
      sawToolUse = true;
      const outIdx = typeof data.output_index === "number" ? data.output_index : 0;
      const blockIndex = outputIndexToBlockIndex.get(outIdx) ?? outIdx;
      const partialJson = typeof data.delta === "string" ? data.delta : "";
      if (partialJson.length > 0) {
        writeSseEvent(downstreamRes, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: partialJson,
          },
        });
      }
      return;
    }

    if (eventName === "response.output_item.done") {
      const outIdx = typeof data.output_index === "number" ? data.output_index : 0;
      const blockIndex = outputIndexToBlockIndex.get(outIdx) ?? outIdx;
      writeSseEvent(downstreamRes, "content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
      return;
    }

    if (eventName === "response.completed" || eventName === "response.incomplete" || eventName === "response.failed") {
      const responseObj = data.response && typeof data.response === "object" ? data.response : {};
      if (typeof responseObj?.usage?.output_tokens === "number") outputTokens = responseObj.usage.output_tokens;
      if (typeof responseObj?.usage?.input_tokens === "number") inputTokens = responseObj.usage.input_tokens;
      if (typeof responseObj.model === "string" && responseObj.model.length > 0) model = responseObj.model;

      let stopReason = "end_turn";
      if (eventName === "response.incomplete" || responseObj.status === "incomplete") stopReason = "max_tokens";
      else if (eventName === "response.failed" || responseObj.status === "failed") stopReason = "error";
      else if (sawToolUse) stopReason = "tool_use";

      writeSseEvent(downstreamRes, "message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: outputTokens,
        },
      });
      writeSseEvent(downstreamRes, "message_stop", { type: "message_stop" });
      finalized = true;
    }
  });

  if (!messageStarted) {
    emitMessageStart(null);
  }
  if (!finalized) {
    writeSseEvent(downstreamRes, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: sawToolUse ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: outputTokens,
      },
    });
    writeSseEvent(downstreamRes, "message_stop", { type: "message_stop" });
  }
  downstreamRes.end();
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitResponsesEvent(res, eventName, payload = {}) {
  const data = payload && typeof payload === "object" ? { ...payload } : {};
  if (typeof data.type !== "string") data.type = eventName;
  writeSseEvent(res, eventName, data);
}

function createStreamedResponseState(fallbackModel) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(36).slice(2, 8);
  const responseId = `resp_${Date.now()}_${nonce}`;
  return {
    response: {
      id: responseId,
      object: "response",
      created_at: now,
      status: "in_progress",
      model: fallbackModel || DEFAULT_MODEL,
      output: [],
      output_text: "",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    },
    messageItemId: `msg_${responseId}`,
    messageOutputIndex: -1,
    functionItemsByCallId: new Map(),
  };
}

function openSseResponse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
}

function ensureStreamMessageItem(state, res) {
  if (state.messageOutputIndex !== -1) {
    return state.response.output[state.messageOutputIndex];
  }
  const item = {
    id: state.messageItemId,
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [{ type: "output_text", text: "" }],
  };
  state.messageOutputIndex = state.response.output.length;
  state.response.output.push(item);
  emitResponsesEvent(res, "response.output_item.added", {
    response_id: state.response.id,
    output_index: state.messageOutputIndex,
    item,
  });
  return item;
}

function appendStreamMessageTextDelta(state, res, textDelta) {
  if (typeof textDelta !== "string" || textDelta.length === 0) return;
  const item = ensureStreamMessageItem(state, res);
  if (!Array.isArray(item.content) || !item.content.length) {
    item.content = [{ type: "output_text", text: "" }];
  }
  if (!item.content[0] || typeof item.content[0] !== "object") {
    item.content[0] = { type: "output_text", text: "" };
  }
  if (typeof item.content[0].text !== "string") item.content[0].text = "";
  item.content[0].text += textDelta;
  state.response.output_text += textDelta;

  emitResponsesEvent(res, "response.output_text.delta", {
    response_id: state.response.id,
    output_index: state.messageOutputIndex,
    item_id: item.id,
    content_index: 0,
    delta: textDelta,
  });
}

function ensureStreamFunctionItem(state, res, callId, nameHint = "", initialArguments = "") {
  if (!callId) return null;
  const existing = state.functionItemsByCallId.get(callId);
  if (existing) {
    if (nameHint && !existing.item.name) existing.item.name = nameHint;
    if (typeof initialArguments === "string" && initialArguments.length > 0 && !existing.item.arguments) {
      existing.item.arguments = initialArguments;
    }
    return existing;
  }

  const item = {
    id: callId,
    type: "function_call",
    call_id: callId,
    name: nameHint || "",
    arguments: typeof initialArguments === "string" ? initialArguments : "",
    status: "in_progress",
  };
  const outputIndex = state.response.output.length;
  state.response.output.push(item);
  const entry = {
    item,
    outputIndex,
    sawArgumentsDelta: false,
  };
  state.functionItemsByCallId.set(callId, entry);
  emitResponsesEvent(res, "response.output_item.added", {
    response_id: state.response.id,
    output_index: outputIndex,
    item,
  });
  return entry;
}

function appendStreamFunctionArgsDelta(state, res, options) {
  const callId = options?.callId;
  const indexHint = typeof options?.indexHint === "number" ? options.indexHint : state.response.output.length;
  const nameHint = options?.nameHint || "";
  const delta = typeof options?.delta === "string" ? options.delta : "";
  const resetOnFirstDelta = Boolean(options?.resetOnFirstDelta);
  if (!callId) return;

  const entry = ensureStreamFunctionItem(state, res, callId, nameHint);
  if (!entry || !delta) return;

  if (resetOnFirstDelta && !entry.sawArgumentsDelta) {
    entry.item.arguments = "";
  }

  entry.item.arguments += delta;
  entry.sawArgumentsDelta = true;

  emitResponsesEvent(res, "response.function_call_arguments.delta", {
    response_id: state.response.id,
    output_index: entry.outputIndex,
    item_id: callId,
    index: indexHint,
    delta,
  });
}

function finalizeStreamedResponse(state, status, failureReason = "max_output_tokens") {
  if (!Array.isArray(state.response.output) || state.response.output.length === 0) {
    state.response.output = [
      {
        id: state.messageItemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: state.response.output_text || "" }],
      },
    ];
    state.messageOutputIndex = 0;
  }

  for (const item of state.response.output) {
    if (item && typeof item === "object") item.status = "completed";
  }

  const usage = state.response.usage || {};
  const inTokens = usage.input_tokens ?? 0;
  const outTokens = usage.output_tokens ?? 0;
  usage.total_tokens = typeof usage.total_tokens === "number" && usage.total_tokens > 0 ? usage.total_tokens : inTokens + outTokens;
  state.response.usage = usage;

  if (status === "failed") {
    state.response.status = "failed";
    state.response.incomplete_details = { reason: failureReason || "error" };
  } else if (status === "incomplete") {
    state.response.status = "incomplete";
    state.response.incomplete_details = { reason: "max_output_tokens" };
  } else {
    state.response.status = "completed";
    delete state.response.incomplete_details;
  }
}

function emitStreamCompletion(res, state) {
  for (let i = 0; i < state.response.output.length; i += 1) {
    const item = state.response.output[i];

    if (i === state.messageOutputIndex && item?.type === "message") {
      const textValue = item?.content?.[0]?.text;
      emitResponsesEvent(res, "response.output_text.done", {
        response_id: state.response.id,
        output_index: i,
        item_id: item.id || state.messageItemId,
        content_index: 0,
        text: typeof textValue === "string" ? textValue : "",
      });
    }

    if (item?.type === "function_call") {
      const callId = item.call_id || item.id || "";
      if (callId) {
        emitResponsesEvent(res, "response.function_call_arguments.done", {
          response_id: state.response.id,
          output_index: i,
          item_id: callId,
          arguments: typeof item.arguments === "string" ? item.arguments : "",
        });
      }
    }

    emitResponsesEvent(res, "response.output_item.done", {
      response_id: state.response.id,
      output_index: i,
      item,
    });
  }

  if (state.response.status === "incomplete") {
    emitResponsesEvent(res, "response.incomplete", { response: state.response });
  } else {
    emitResponsesEvent(res, "response.completed", { response: state.response });
  }
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let eventName = "";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const rawData = dataLines.join("\n");
  if (!rawData) return null;
  if (rawData === "[DONE]") {
    return { event: eventName, data: null, done: true };
  }
  return {
    event: eventName,
    data: safeJsonParse(rawData, null),
    done: false,
  };
}

async function forEachSseEvent(upstreamResponse, onEvent) {
  const decoder = new TextDecoder("utf-8");
  const reader = upstreamResponse.body.getReader();
  let buffer = "";
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    const decoded = decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer += decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let splitIndex;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      if (!block.trim()) continue;
      const evt = parseSseBlock(block);
      if (!evt) continue;
      await onEvent(evt);
    }
  }

  const remaining = buffer.trim();
  if (!remaining) return;
  const evt = parseSseBlock(remaining);
  if (!evt) return;
  await onEvent(evt);
}

async function pipeSsePassThrough(upstreamResponse, downstreamRes) {
  openSseResponse(downstreamRes);
  const reader = upstreamResponse.body.getReader();
  let done = false;
  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (value && value.length > 0) {
      downstreamRes.write(Buffer.from(value));
    }
  }
  downstreamRes.end();
}

async function streamChatCompletionsAsResponses(upstreamResponse, downstreamRes, fallbackModel) {
  openSseResponse(downstreamRes);
  const state = createStreamedResponseState(fallbackModel);
  const toolCallIdByIndex = new Map();
  let createdSent = false;
  let finalStatus = "completed";
  let upstreamError = null;

  const ensureCreated = () => {
    if (createdSent) return;
    emitResponsesEvent(downstreamRes, "response.created", { response: state.response });
    createdSent = true;
  };

  await forEachSseEvent(upstreamResponse, async ({ event, data, done }) => {
    if (done) return;
    if (!data || typeof data !== "object") return;
    if (upstreamError) return;

    if (event === "error" || data.type === "error" || data.error) {
      upstreamError = data.error && typeof data.error === "object" ? data.error : data;
      return;
    }

    if (typeof data.id === "string" && data.id.length > 0 && !createdSent) {
      state.response.id = `resp_${data.id}`;
      state.messageItemId = `msg_${data.id}`;
    }
    if (typeof data.model === "string" && data.model.length > 0) {
      state.response.model = data.model;
    }
    if (typeof data.created === "number" && Number.isFinite(data.created)) {
      state.response.created_at = data.created;
    }

    const usage = data.usage;
    if (usage && typeof usage === "object") {
      if (typeof usage.prompt_tokens === "number") state.response.usage.input_tokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") state.response.usage.output_tokens = usage.completion_tokens;
      if (typeof usage.total_tokens === "number") state.response.usage.total_tokens = usage.total_tokens;
    }

    ensureCreated();

    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (!choices.length || !choices[0] || typeof choices[0] !== "object") return;
    const choice = choices[0];
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      appendStreamMessageTextDelta(state, downstreamRes, delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        if (!toolCallDelta || typeof toolCallDelta !== "object") continue;
        const index = typeof toolCallDelta.index === "number" ? toolCallDelta.index : 0;
        const incomingCallId = typeof toolCallDelta.id === "string" && toolCallDelta.id.length > 0 ? toolCallDelta.id : null;
        const callId = incomingCallId || toolCallIdByIndex.get(index) || `call_${index + 1}`;
        toolCallIdByIndex.set(index, callId);

        const functionPart = toolCallDelta.function && typeof toolCallDelta.function === "object" ? toolCallDelta.function : {};
        const nameHint = typeof functionPart.name === "string" ? functionPart.name : "";
        ensureStreamFunctionItem(state, downstreamRes, callId, nameHint);

        const argsDelta = typeof functionPart.arguments === "string" ? functionPart.arguments : "";
        if (argsDelta.length > 0) {
          appendStreamFunctionArgsDelta(state, downstreamRes, {
            callId,
            indexHint: index,
            delta: argsDelta,
          });
        }
      }
    }

    const finishReason = choice.finish_reason;
    if (finishReason === "length") {
      finalStatus = "incomplete";
    }
  });

  ensureCreated();
  if (upstreamError) {
    finalizeStreamedResponse(state, "failed", "error");
    state.response.error = upstreamError;
    emitResponsesEvent(downstreamRes, "response.failed", {
      response: state.response,
      error: upstreamError,
    });
    writeSseDone(downstreamRes);
    downstreamRes.end();
    return;
  }

  finalizeStreamedResponse(state, finalStatus);
  emitStreamCompletion(downstreamRes, state);
  writeSseDone(downstreamRes);
  downstreamRes.end();
}

async function streamMessagesAsResponses(upstreamResponse, downstreamRes, fallbackModel) {
  openSseResponse(downstreamRes);
  const state = createStreamedResponseState(fallbackModel);
  const callIdByContentIndex = new Map();
  let createdSent = false;
  let finalStatus = "completed";
  let upstreamError = null;

  const ensureCreated = () => {
    if (createdSent) return;
    emitResponsesEvent(downstreamRes, "response.created", { response: state.response });
    createdSent = true;
  };

  await forEachSseEvent(upstreamResponse, async ({ event, data, done }) => {
    if (done) return;
    if (!data || typeof data !== "object") return;
    if (upstreamError) return;

    const eventName = event || data.type || "";

    if (eventName === "error" || data.type === "error" || data.error) {
      upstreamError = data.error && typeof data.error === "object" ? data.error : data;
      return;
    }

    if (eventName === "message_start") {
      const message = data.message && typeof data.message === "object" ? data.message : {};
      if (typeof message.id === "string" && message.id.length > 0 && !createdSent) {
        state.response.id = `resp_${message.id}`;
        state.messageItemId = `msg_${message.id}`;
      }
      if (typeof message.model === "string" && message.model.length > 0) {
        state.response.model = message.model;
      }
      if (message.usage && typeof message.usage === "object") {
        if (typeof message.usage.input_tokens === "number") {
          state.response.usage.input_tokens = message.usage.input_tokens;
        }
        if (typeof message.usage.output_tokens === "number") {
          state.response.usage.output_tokens = message.usage.output_tokens;
        }
      }
      ensureCreated();
      return;
    }

    ensureCreated();

    if (eventName === "content_block_start") {
      const index = typeof data.index === "number" ? data.index : 0;
      const block = data.content_block && typeof data.content_block === "object" ? data.content_block : {};

      if (block.type === "text") {
        if (typeof block.text === "string" && block.text.length > 0) {
          appendStreamMessageTextDelta(state, downstreamRes, block.text);
        }
        return;
      }

      if (block.type === "tool_use") {
        const callId = (typeof block.id === "string" && block.id.length > 0 ? block.id : null) || `call_${index + 1}`;
        callIdByContentIndex.set(index, callId);

        let initialArguments = "";
        if (block.input && typeof block.input === "object" && !Array.isArray(block.input)) {
          if (Object.keys(block.input).length > 0) {
            initialArguments = stringifyUnknown(block.input);
          }
        }

        ensureStreamFunctionItem(state, downstreamRes, callId, typeof block.name === "string" ? block.name : "", initialArguments);
      }
      return;
    }

    if (eventName === "content_block_delta") {
      const index = typeof data.index === "number" ? data.index : 0;
      const delta = data.delta && typeof data.delta === "object" ? data.delta : {};

      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        appendStreamMessageTextDelta(state, downstreamRes, delta.text);
        return;
      }

      const partialJson =
        typeof delta.partial_json === "string" && delta.partial_json.length > 0
          ? delta.partial_json
          : typeof delta.text === "string" && delta.text.length > 0
            ? delta.text
            : "";
      if (partialJson.length > 0) {
        const callId = callIdByContentIndex.get(index) || `call_${index + 1}`;
        callIdByContentIndex.set(index, callId);
        appendStreamFunctionArgsDelta(state, downstreamRes, {
          callId,
          indexHint: index,
          delta: partialJson,
          resetOnFirstDelta: true,
        });
      }
      return;
    }

    if (eventName === "message_delta") {
      if (data.usage && typeof data.usage === "object") {
        if (typeof data.usage.input_tokens === "number") state.response.usage.input_tokens = data.usage.input_tokens;
        if (typeof data.usage.output_tokens === "number") state.response.usage.output_tokens = data.usage.output_tokens;
      }
      const stopReason = data.delta?.stop_reason ?? data.stop_reason;
      if (stopReason === "max_tokens") {
        finalStatus = "incomplete";
      }
      return;
    }
  });

  ensureCreated();
  if (upstreamError) {
    finalizeStreamedResponse(state, "failed", "error");
    state.response.error = upstreamError;
    emitResponsesEvent(downstreamRes, "response.failed", {
      response: state.response,
      error: upstreamError,
    });
    writeSseDone(downstreamRes);
    downstreamRes.end();
    return;
  }

  finalizeStreamedResponse(state, finalStatus);
  emitStreamCompletion(downstreamRes, state);
  writeSseDone(downstreamRes);
  downstreamRes.end();
}

async function streamResponsesAsChatChunks(upstreamResponse, downstreamRes, model) {
  downstreamRes.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const decoder = new TextDecoder("utf-8");
  const reader = upstreamResponse.body.getReader();
  const created = Math.floor(Date.now() / 1000);

  let chatId = `chatcmpl_${Date.now()}`;
  let sentRole = false;
  let buffer = "";
  let done = false;
  let finishReason = "stop";
  let chunkIndex = 0;

  const sendDelta = (delta) => {
    writeSse(downstreamRes, {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: null,
        },
      ],
    });
  };

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let splitIndex;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, splitIndex).trim();
      buffer = buffer.slice(splitIndex + 2);
      if (!block) continue;

      let eventName = "";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const rawData = dataLines.join("\n");
      if (!rawData || rawData === "[DONE]") continue;

      const data = safeJsonParse(rawData, null);
      if (!data) continue;

      if (data.id && typeof data.id === "string" && data.id.length > 0) {
        chatId = `chatcmpl_${data.id}`;
      }

      if (eventName === "response.output_item.added") {
        const item = data.item;
        if (item?.type === "function_call") {
          if (!sentRole) {
            sendDelta({ role: "assistant" });
            sentRole = true;
          }
          writeSse(downstreamRes, {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: chunkIndex,
                      id: item.call_id || `call_${chunkIndex + 1}`,
                      type: "function",
                      function: {
                        name: item.name || "",
                        arguments: "",
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          chunkIndex += 1;
        }
      }

      if (eventName === "response.function_call_arguments.delta") {
        const delta = data.delta || "";
        const itemId = data.item_id;
        writeSse(downstreamRes, {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: itemId || "call_1",
                    type: "function",
                    function: {
                      arguments: delta,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }

      if (eventName === "response.output_text.delta") {
        const deltaText = data.delta || "";
        if (!sentRole) {
          sendDelta({ role: "assistant" });
          sentRole = true;
        }
        if (deltaText) sendDelta({ content: deltaText });
      }

      if (eventName === "response.completed") {
        const output = data.response?.output;
        const hasTool = Array.isArray(output) && output.some((x) => x?.type === "function_call");
        finishReason = hasTool ? "tool_calls" : "stop";
      }

      if (eventName === "response.incomplete") {
        finishReason = "length";
      }
    }
  }

  writeSse(downstreamRes, {
    id: chatId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  });
  downstreamRes.write("data: [DONE]\n\n");
  downstreamRes.end();
}

function addCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,x-responses-target,x-api-key,anthropic-version",
  );
}

async function readUpstreamJson(upstreamResponse) {
  const raw = await upstreamResponse.text();
  if (!raw) return { raw, json: {} };
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    const sseResponse = extractResponseObjectFromSse(raw);
    if (sseResponse) {
      return { raw, json: sseResponse };
    }
    return { raw, json: null };
  }
}

function compactText(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim();
}

function clipText(raw, max = 280) {
  const t = compactText(raw);
  if (t.length <= max) return t;
  return `${t.slice(0, max)}...`;
}

function buildNonJsonUpstreamMessage(raw) {
  const text = String(raw || "");
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = safeJsonParse(data, null);
    const msg =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.response?.error?.message ||
      (typeof parsed === "string" ? parsed : "");
    if (typeof msg === "string" && msg.trim().length > 0) {
      return `Upstream returned non-JSON envelope: ${clipText(msg)}`;
    }
  }

  const snippet = clipText(text);
  if (snippet) return `Upstream returned non-JSON response: ${snippet}`;
  return "Upstream returned invalid JSON";
}

function extractResponseObjectFromSse(raw) {
  const text = String(raw || "");
  if (!text.includes("data:")) return null;

  const blocks = text.split(/\r?\n\r?\n/);
  let found = null;
  for (const block of blocks) {
    if (!block) continue;
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;

    const joined = dataLines.join("\n").trim();
    if (!joined || joined === "[DONE]") continue;
    const parsed = safeJsonParse(joined, null);
    if (!parsed || typeof parsed !== "object") continue;

    if (parsed.object === "response") {
      found = parsed;
      continue;
    }

    if (parsed.response && typeof parsed.response === "object" && parsed.response.object === "response") {
      found = parsed.response;
    }
  }
  return found;
}

function resolveResponsesTarget(req) {
  const headerValue = req.headers["x-responses-target"];
  const targetFromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return normalizeResponsesTarget(targetFromHeader || RESPONSES_TARGET);
}

async function handleChatCompletions(req, res) {
  if (!RESPONSES_API_KEY) {
    writeJson(
      res,
      500,
      createError(500, "RESPONSES_API_KEY (or OPENAI/CHAT API key) is required for /v1/chat/completions bridge", "configuration_error"),
    );
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, createError(400, err.message));
    return;
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    writeJson(res, 400, createError(400, "`messages` is required and must be an array"));
    return;
  }

  const payload = chatRequestToResponsesPayload(body);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(RESPONSES_UPSTREAM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESPONSES_API_KEY}`,
        "x-api-key": RESPONSES_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    writeJson(res, 502, createError(502, `Upstream request failed: ${err.message}`, "api_connection_error"));
    return;
  }

  if (body.stream === true) {
    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errText = await upstreamResponse.text().catch(() => "");
      writeJson(res, upstreamResponse.status || 502, {
        ...createError(upstreamResponse.status || 502, "Upstream stream failed", "api_error"),
        upstream: errText,
      });
      return;
    }

    try {
        await streamResponsesAsChatChunks(upstreamResponse, res, pickModel(body.model));
    } catch (err) {
      if (!res.headersSent) {
        writeJson(res, 502, createError(502, `Stream bridge failed: ${err.message}`, "api_error"));
      } else {
        res.end();
      }
    }
    return;
  }

  const { raw, json } = await readUpstreamJson(upstreamResponse);
  if (json === null) {
    const status = upstreamResponse.ok ? 502 : upstreamResponse.status || 502;
    writeJson(res, status, createError(status, buildNonJsonUpstreamMessage(raw), "api_error"));
    return;
  }

  if (!upstreamResponse.ok) {
    const status = upstreamResponse.status || 500;
    const msg = json?.error?.message || "Upstream API error";
    writeJson(res, status, createError(status, msg, json?.error?.type || "api_error"));
    return;
  }

  writeJson(res, 200, responsesToChatCompletion(json, pickModel(body.model)));
}

async function handleModels(req, res) {
  if (!RESPONSES_API_KEY) {
    writeJson(
      res,
      500,
      createError(500, "RESPONSES_API_KEY (or OPENAI/CHAT API key) is required for /v1/models bridge", "configuration_error"),
    );
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(RESPONSES_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${RESPONSES_API_KEY}`,
        "x-api-key": RESPONSES_API_KEY,
      },
    });
  } catch (err) {
    writeJson(res, 502, createError(502, `Upstream request failed: ${err.message}`, "api_connection_error"));
    return;
  }

  const { raw, json } = await readUpstreamJson(upstreamResponse);
  if (json === null) {
    const status = upstreamResponse.ok ? 502 : upstreamResponse.status || 502;
    writeJson(res, status, createError(status, buildNonJsonUpstreamMessage(raw), "api_error"));
    return;
  }

  if (!upstreamResponse.ok) {
    const status = upstreamResponse.status || 500;
    const message = json?.error?.message || json?.message || "Upstream API error";
    const type = json?.error?.type || "api_error";
    writeJson(res, status, createError(status, message, type));
    return;
  }

  writeJson(res, 200, json);
}

async function handleMessages(req, res) {
  if (!RESPONSES_API_KEY) {
    writeJson(res, 500, createAnthropicError("RESPONSES_API_KEY is required for /v1/messages bridge", "authentication_error"));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, createAnthropicError(err.message, "invalid_request_error"));
    return;
  }

  if (!Array.isArray(body.messages)) {
    writeJson(res, 400, createAnthropicError("`messages` is required and must be an array", "invalid_request_error"));
    return;
  }

  const payload = anthropicMessagesRequestToResponsesPayload(body);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(RESPONSES_UPSTREAM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESPONSES_API_KEY}`,
        "x-api-key": RESPONSES_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    writeJson(res, 502, createAnthropicError(`Upstream request failed: ${err.message}`, "api_error"));
    return;
  }

  if (body.stream === true) {
    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errText = await upstreamResponse.text().catch(() => "");
      writeJson(res, upstreamResponse.status || 502, createAnthropicError(errText || "Upstream stream failed", "api_error"));
      return;
    }

    try {
      await streamResponsesAsMessagesEvents(upstreamResponse, res, pickModel(body.model));
    } catch (err) {
      if (!res.headersSent) {
        writeJson(res, 502, createAnthropicError(`Stream bridge failed: ${err.message}`, "api_error"));
      } else {
        res.end();
      }
    }
    return;
  }

  const { raw, json } = await readUpstreamJson(upstreamResponse);
  if (json === null) {
    const status = upstreamResponse.ok ? 502 : upstreamResponse.status || 502;
    writeJson(res, status, createAnthropicError(buildNonJsonUpstreamMessage(raw), "api_error"));
    return;
  }

  if (!upstreamResponse.ok) {
    const status = upstreamResponse.status || 500;
    const message = json?.error?.message || json?.message || "Upstream API error";
    const type = json?.error?.type || "api_error";
    writeJson(res, status, createAnthropicError(message, type));
    return;
  }

  writeJson(res, 200, responsesToAnthropicMessage(json, pickModel(body.model)));
}

async function handleResponses(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, createError(400, err.message));
    return;
  }

  if (typeof body.input === "undefined") {
    writeJson(res, 400, createError(400, "`input` is required for this bridge"));
    return;
  }
  const wantsStream = body.stream === true;

  const target = resolveResponsesTarget(req);

  if (target === "responses") {
    if (!RESPONSES_API_KEY) {
      writeJson(
        res,
        500,
        createError(500, "RESPONSES_API_KEY (or OPENAI/CHAT API key) is required for responses target", "configuration_error"),
      );
      return;
    }

    const payload = applyForcedSettings(
      sanitizeCodexCompatPayload({
        ...(body && typeof body === "object" ? body : {}),
        model: pickModel(body?.model),
      }),
      "responses",
    );
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(RESPONSES_UPSTREAM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESPONSES_API_KEY}`,
          "x-api-key": RESPONSES_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      writeJson(res, 502, createError(502, `Upstream request failed: ${err.message}`, "api_connection_error"));
      return;
    }

    if (wantsStream) {
      if (!upstreamResponse.ok || !upstreamResponse.body) {
        const errText = await upstreamResponse.text().catch(() => "");
        writeJson(res, upstreamResponse.status || 502, {
          ...createError(upstreamResponse.status || 502, "Upstream stream failed", "api_error"),
          upstream: errText,
        });
        return;
      }

      try {
        await pipeSsePassThrough(upstreamResponse, res);
      } catch (err) {
        if (!res.headersSent) {
          writeJson(res, 502, createError(502, `Stream bridge failed: ${err.message}`, "api_error"));
        } else {
          res.end();
        }
      }
      return;
    }

    const { raw, json } = await readUpstreamJson(upstreamResponse);
    if (json === null) {
      const status = upstreamResponse.ok ? 502 : upstreamResponse.status || 502;
      writeJson(res, status, createError(status, buildNonJsonUpstreamMessage(raw), "api_error"));
      return;
    }

    if (!upstreamResponse.ok) {
      const status = upstreamResponse.status || 500;
      const message = json?.error?.message || json?.message || "Upstream API error";
      const type = json?.error?.type || "api_error";
      writeJson(res, status, createError(status, message, type));
      return;
    }

    writeJson(res, 200, json);
    return;
  }

  if (target === "chat") {
    if (!CHAT_API_KEY) {
      writeJson(res, 500, createError(500, "CHAT_API_KEY (or OPENAI_API_KEY) is required for chat target", "configuration_error"));
      return;
    }

    const payload = responsesRequestToChatPayload(body);
    if (wantsStream) payload.stream = true;
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CHAT_API_KEY}`,
          "x-api-key": CHAT_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      writeJson(res, 502, createError(502, `Upstream request failed: ${err.message}`, "api_connection_error"));
      return;
    }

    if (wantsStream) {
      if (!upstreamResponse.ok || !upstreamResponse.body) {
        const errText = await upstreamResponse.text().catch(() => "");
        writeJson(res, upstreamResponse.status || 502, {
          ...createError(upstreamResponse.status || 502, "Upstream stream failed", "api_error"),
          upstream: errText,
        });
        return;
      }

      try {
        await streamChatCompletionsAsResponses(upstreamResponse, res, pickModel(body.model));
      } catch (err) {
        if (!res.headersSent) {
          writeJson(res, 502, createError(502, `Stream bridge failed: ${err.message}`, "api_error"));
        } else {
          res.end();
        }
      }
      return;
    }

    const { raw, json } = await readUpstreamJson(upstreamResponse);
    if (json === null) {
      const status = upstreamResponse.ok ? 502 : upstreamResponse.status || 502;
      writeJson(res, status, createError(status, buildNonJsonUpstreamMessage(raw), "api_error"));
      return;
    }

    if (!upstreamResponse.ok) {
      const status = upstreamResponse.status || 500;
      const message = json?.error?.message || json?.message || "Upstream API error";
      const type = json?.error?.type || "api_error";
      writeJson(res, status, createError(status, message, type));
      return;
    }

    writeJson(res, 200, chatCompletionToResponses(json, pickModel(body.model)));
    return;
  }

  if (!MESSAGES_API_KEY) {
    writeJson(
      res,
      500,
      createError(500, "MESSAGES_API_KEY (or ANTHROPIC_API_KEY) is required for messages target", "configuration_error"),
    );
    return;
  }

  const payload = responsesRequestToMessagesPayload(body);
  if (wantsStream) payload.stream = true;
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": MESSAGES_API_KEY,
        Authorization: `Bearer ${MESSAGES_API_KEY}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    writeJson(res, 502, createError(502, `Upstream request failed: ${err.message}`, "api_connection_error"));
    return;
  }

  if (wantsStream) {
    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errText = await upstreamResponse.text().catch(() => "");
      writeJson(res, upstreamResponse.status || 502, {
        ...createError(upstreamResponse.status || 502, "Upstream stream failed", "api_error"),
        upstream: errText,
      });
      return;
    }

    try {
      await streamMessagesAsResponses(upstreamResponse, res, pickModel(body.model));
    } catch (err) {
      if (!res.headersSent) {
        writeJson(res, 502, createError(502, `Stream bridge failed: ${err.message}`, "api_error"));
      } else {
        res.end();
      }
    }
    return;
  }

  const { raw, json } = await readUpstreamJson(upstreamResponse);
  if (json === null) {
    const status = upstreamResponse.ok ? 502 : upstreamResponse.status || 502;
    writeJson(res, status, createError(status, buildNonJsonUpstreamMessage(raw), "api_error"));
    return;
  }

  if (!upstreamResponse.ok) {
    const status = upstreamResponse.status || 500;
    const message = json?.error?.message || json?.message || "Upstream API error";
    const type = json?.error?.type || "api_error";
    writeJson(res, status, createError(status, message, type));
    return;
  }

  writeJson(res, 200, messagesToResponses(json, pickModel(body.model)));
}

const server = http.createServer(async (req, res) => {
  addCors(res);

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || "localhost";
    const parsedUrl = new URL(req.url || "/", `http://${host}`);
    const path = parsedUrl.pathname;

    if (req.method === "GET" && path === "/health") {
      writeJson(res, 200, {
        ok: true,
        responses_target: RESPONSES_TARGET,
        responses_upstream_url: RESPONSES_UPSTREAM_URL,
        responses_models_url: RESPONSES_MODELS_URL,
        force_model_id: FORCE_MODEL_ID || null,
        force_reasoning_effort: FORCE_REASONING_EFFORT || null,
      });
      return;
    }

    if (req.method === "GET" && path === "/v1/models") {
      await handleModels(req, res);
      return;
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }

    if (req.method === "POST" && path === "/v1/messages") {
      await handleMessages(req, res);
      return;
    }

    if (req.method === "POST" && path === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }

    writeJson(res, 404, createError(404, "Not found"));
  } catch (err) {
    if (!res.headersSent) {
      writeJson(res, 500, createError(500, `Internal error: ${err.message}`, "internal_error"));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
  console.log(`Responses target default: ${RESPONSES_TARGET}`);
});

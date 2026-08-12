export interface GatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * Omitted from the request unless set: reasoning models (the gpt-5 family,
   * o-series) reject any value other than their default.
   */
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

export const DEFAULT_BRAINTRUST_GATEWAY_BASE_URL = "https://gateway.braintrust.dev";
export const DEFAULT_JUDGE_MODEL = "gpt-5-mini";

export function gatewayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Required<Omit<GatewayOptions, "temperature">> {
  return {
    apiKey: env.BRAINTRUST_API_KEY ?? "",
    baseUrl: env.BRAINTRUST_GATEWAY_BASE_URL ?? DEFAULT_BRAINTRUST_GATEWAY_BASE_URL,
    model: env.BRAINTRUST_JUDGE_MODEL ?? env.BRAINTRUST_MODEL ?? DEFAULT_JUDGE_MODEL,
  };
}

export async function completeWithBraintrustGateway(
  messages: GatewayMessage[],
  options: GatewayOptions = {},
): Promise<string> {
  const envConfig = gatewayConfigFromEnv();
  const apiKey = options.apiKey ?? envConfig.apiKey;
  const baseUrl = options.baseUrl ?? envConfig.baseUrl;
  const model = options.model ?? envConfig.model;
  const temperature = options.temperature;

  if (apiKey.trim().length === 0) {
    throw new Error("Missing BRAINTRUST_API_KEY. Export it in your shell or set it in .env.");
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      ...(temperature === undefined ? {} : { temperature }),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse;

  if (!response.ok) {
    throw new Error(
      `Braintrust Gateway request failed (${response.status}): ${body.error?.message ?? response.statusText}`,
    );
  }

  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Braintrust Gateway response did not include a message content string.");
  }

  return content;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Judge response field ${field} must be a non-empty string.`);
  }
  return value.trim();
}

export function parseJsonObject(response: string): Record<string, unknown> {
  const trimmed = response.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace < firstBrace) {
    throw new Error("Judge response did not contain a JSON object.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    throw new Error("Judge response was not valid JSON.", { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error("Judge response must be a JSON object.");
  }

  return parsed;
}

export type JudgeCompletion = (messages: GatewayMessage[]) => Promise<string>;

/**
 * Run a completion whose response must parse; on a parse/validation failure,
 * retry once with the validation error appended to the conversation.
 */
export async function completeJsonWithRetry<T>(
  complete: JudgeCompletion,
  messages: GatewayMessage[],
  parse: (response: string) => T,
): Promise<T> {
  const firstResponse = await complete(messages);
  try {
    return parse(firstResponse);
  } catch (firstError) {
    const errorMessage = firstError instanceof Error ? firstError.message : String(firstError);
    const retryResponse = await complete([
      ...messages,
      { role: "assistant", content: firstResponse },
      {
        role: "user",
        content: `The previous response failed validation: ${errorMessage}\nReturn one corrected JSON object only.`,
      },
    ]);
    return parse(retryResponse);
  }
}

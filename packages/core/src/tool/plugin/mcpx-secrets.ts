export * as McpxSecrets from "./mcpx-secrets.js"

export interface SecretPromptRequest {
  readonly server: string
  readonly secretKey: string
  readonly message?: string
}

export interface SecretPromptHandler {
  (request: SecretPromptRequest): Promise<string | undefined>
}

// A host that can ask the user (the TUI or the app) registers its prompt here.
let promptHandler: SecretPromptHandler | undefined

export const setSecretPromptHandler = (handler: SecretPromptHandler | undefined): void => {
  promptHandler = handler
}

/**
 * With no host prompt, a secret can still come from the environment under its own name
 * (for example OPENAI_API_KEY), so a headless run works when the variable is already set.
 */
const resolveSecretFromEnvironment: SecretPromptHandler = async (request) => process.env[request.secretKey] || undefined

/**
 * Checks if a response error or status indicates a missing secret.
 */
export const detectMissingSecret = (errorOrBody: any): { isSecretRequired: boolean; secretKey?: string; server?: string } => {
  if (!errorOrBody) return { isSecretRequired: false }

  const errStr = typeof errorOrBody === "string" ? errorOrBody : (errorOrBody.message || errorOrBody.error || "")
  const secretKey = errorOrBody.secretRequired || errorOrBody.secretKey

  if (secretKey) {
    return {
      isSecretRequired: true,
      secretKey: String(secretKey),
      server: errorOrBody.server,
    }
  }

  // Regex patterns for common secret errors
  const match = errStr.match(/(?:missing|required)\s+(?:api[_-]?key|token|secret|credential)\s*(?::|=|\s)\s*([A-Za-z0-9_]+)/i)
    || errStr.match(/([A-Za-z0-9_]+_(?:API_KEY|TOKEN|SECRET))\s+(?:is\s+)?required/i)

  if (match) {
    return {
      isSecretRequired: true,
      secretKey: match[1],
      server: errorOrBody.server,
    }
  }

  return { isSecretRequired: false }
}

/**
 * Executes a daemon call with just-in-time secret prompting and injection when the daemon reports a missing secret.
 */
export const callWithSecretPrompt = async (
  options: {
    path: string
    method?: string
    body?: any
    headers?: Record<string, string>
    callDaemon: (path: string, method?: string, body?: any, headers?: Record<string, string>) => Promise<any>
    promptSecret?: (request: SecretPromptRequest) => Promise<string | undefined>
  },
): Promise<any> => {
  const { path, method = "GET", body, headers = {}, callDaemon, promptSecret = promptHandler ?? resolveSecretFromEnvironment } = options

  try {
    return await callDaemon(path, method, body, headers)
  } catch (err: any) {
    const missing = detectMissingSecret(err?.response || err)
    if (!missing.isSecretRequired || !missing.secretKey) throw err

    const server = missing.server || body?.server || "mcpx"
    const secretVal = await promptSecret({
      server,
      secretKey: missing.secretKey,
      message: `MCP server "${server}" requires secret key "${missing.secretKey}".`,
    })
    if (!secretVal) {
      throw new Error(
        `MCP server "${server}" requires the secret ${missing.secretKey}, and no value is available. Set ${missing.secretKey} in the environment, then retry.`,
      )
    }

    // Inject into request headers and retry once
    return await callDaemon(path, method, body, {
      ...headers,
      [`x-mcpx-secret-${missing.secretKey.toLowerCase()}`]: secretVal,
      "x-mcpx-injected-secrets": JSON.stringify({ [missing.secretKey]: secretVal }),
    })
  }
}

export * as ModelAlias from "./model-alias.js"

export interface Aliases {
  readonly providers?: Readonly<Record<string, string>>
  readonly models?: Readonly<Record<string, string>>
  readonly variants?: Readonly<Record<string, string>>
}

export class AliasCycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AliasCycleError"
  }
}

export class AliasMaxDepthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AliasMaxDepthError"
  }
}

export interface ResolvedRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
  readonly ref: string
}

export type ExistsPredicate = (ref: { providerID: string; modelID: string }) => boolean

const MAX_DEPTH = 10

/**
 * Resolves a model reference string (which may use provider, model, or variant aliases)
 * into a canonical `provider/model[#variant]` reference string.
 */
export function resolve(aliases: Aliases | undefined, input: string, exists?: ExistsPredicate): string {
  const result = resolveRef(aliases, input, exists)
  return result.variant ? `${result.providerID}/${result.id}#${result.variant}` : `${result.providerID}/${result.id}`
}

/**
 * Resolves a model reference string into a structured resolved ref.
 */
export function resolveRef(aliases: Aliases | undefined, input: string, exists?: ExistsPredicate): ResolvedRef {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Empty model reference cannot be resolved")
  }

  if (!aliases || (!aliases.providers && !aliases.models && !aliases.variants)) {
    return parseRefString(trimmed)
  }

  let current = trimmed
  let explicitVariant: string | undefined
  const visited = new Set<string>()
  let depth = 0
  let settled = false

  while (depth < MAX_DEPTH) {
    depth++
    if (visited.has(current)) {
      throw new AliasCycleError(`Cycle detected in alias resolution: ${current}`)
    }
    visited.add(current)

    // Separate variant from model reference if present
    const hashIdx = current.indexOf("#")
    let base = hashIdx === -1 ? current : current.slice(0, hashIdx)
    const variantInCurrent = hashIdx === -1 ? undefined : current.slice(hashIdx + 1)
    if (variantInCurrent !== undefined && (!variantInCurrent || variantInCurrent.includes("#"))) {
      throw new Error(`Invalid model reference: ${current}`)
    }
    if (variantInCurrent !== undefined && explicitVariant === undefined) {
      explicitVariant = variantInCurrent
    }

    // Rule 1: Global model alias (no "/" in base)
    if (!base.includes("/")) {
      const aliasTarget = aliases.models?.[base]
      if (aliasTarget) {
        current = aliasTarget
        continue
      }
      // If it doesn't contain a slash and isn't an alias, cannot be a valid standard ref
      settled = true
      break
    }

    // Split provider and model
    const slashIdx = base.indexOf("/")
    let provider = base.slice(0, slashIdx)
    let model = base.slice(slashIdx + 1)

    // Check if the exact provider/model exists; if so, real ID wins
    if (exists && exists({ providerID: provider, modelID: model })) {
      settled = true
      break
    }

    // Check scoped model alias under current provider name first (e.g. "openai/gpt-4o")
    const origScopedKey = `${provider}/${model}`
    const origScopedAlias = aliases.models?.[origScopedKey]
    if (origScopedAlias) {
      if (origScopedAlias.includes("/")) {
        current = origScopedAlias
      } else {
        const scopedHash = origScopedAlias.indexOf("#")
        if (scopedHash !== -1) {
          const scopedModel = origScopedAlias.slice(0, scopedHash)
          const scopedVar = origScopedAlias.slice(scopedHash + 1)
          current = `${provider}/${scopedModel}#${scopedVar}`
        } else {
          current = `${provider}/${origScopedAlias}`
        }
      }
      continue
    }

    let modified = false

    // Rule 2: Provider alias
    const providerAlias = aliases.providers?.[provider]
    if (providerAlias !== undefined && providerAlias !== provider) {
      if (!providerAlias || providerAlias.includes("/") || providerAlias.includes("#")) {
        throw new Error(`Invalid model reference: ${current}`)
      }
      provider = providerAlias
      modified = true
    }

    // Rule 3: Provider-scoped model alias under resolved provider
    const scopedKey = `${provider}/${model}`
    const scopedAlias = aliases.models?.[scopedKey]
    if (scopedAlias) {
      // Scoped alias target could be "newModel" or "newProvider/newModel"
      if (scopedAlias.includes("/")) {
        current = scopedAlias
      } else {
        const scopedHash = scopedAlias.indexOf("#")
        if (scopedHash !== -1) {
          const scopedModel = scopedAlias.slice(0, scopedHash)
          const scopedVar = scopedAlias.slice(scopedHash + 1)
          current = `${provider}/${scopedModel}#${scopedVar}`
        } else {
          current = `${provider}/${scopedAlias}`
        }
      }
      continue
    }

    if (modified) {
      current = `${provider}/${model}`
      continue
    }

    settled = true
    break
  }

  if (!settled) {
    throw new AliasMaxDepthError(`Max alias resolution depth exceeded for: ${input}`)
  }

  // Parse the settled base provider and model
  const settledHash = current.indexOf("#")
  const settledBase = settledHash === -1 ? current : current.slice(0, settledHash)
  const settledVariant = settledHash === -1 ? undefined : current.slice(settledHash + 1)

  const slashIdx = settledBase.indexOf("/")
  if (slashIdx <= 0 || slashIdx === settledBase.length - 1) {
    throw new Error(`Invalid model reference after alias resolution: ${settledBase}`)
  }

  const finalProvider = settledBase.slice(0, slashIdx)
  const finalModel = settledBase.slice(slashIdx + 1)
  const initialVariant = explicitVariant ?? settledVariant

  // Rule 4: Variant / effort resolution (most specific wins)
  let finalVariant = initialVariant
  if (initialVariant !== undefined && aliases.variants) {
    finalVariant = resolveVariant(aliases.variants, finalProvider, finalModel, initialVariant)
    if (!finalVariant || finalVariant.includes("#")) {
      throw new Error(`Invalid model reference: ${finalProvider}/${finalModel}#${finalVariant}`)
    }
  }

  const canonicalRef = finalVariant ? `${finalProvider}/${finalModel}#${finalVariant}` : `${finalProvider}/${finalModel}`

  return {
    providerID: finalProvider,
    id: finalModel,
    variant: finalVariant,
    ref: canonicalRef,
  }
}

/**
 * Resolves a variant name using precedence:
 * 1. provider/model#variant (provider model effort)
 * 2. * /model#variant (model effort)
 * 3. provider/*#variant (provider effort)
 * 4. * /*#variant (global wildcard effort)
 * 5. variant (bare effort)
 */
function resolveVariant(
  variantAliases: Readonly<Record<string, string>>,
  provider: string,
  model: string,
  variant: string,
): string {
  // 1. provider/model#variant
  const key1 = `${provider}/${model}#${variant}`
  if (key1 in variantAliases) return variantAliases[key1]

  // 2. */model#variant
  const key2 = `*/${model}#${variant}`
  if (key2 in variantAliases) return variantAliases[key2]

  // 3. provider/*#variant
  const key3 = `${provider}/*#${variant}`
  if (key3 in variantAliases) return variantAliases[key3]

  // 4. */*#variant
  const key4 = `*/*#${variant}`
  if (key4 in variantAliases) return variantAliases[key4]

  // 5. bare variant
  if (variant in variantAliases) return variantAliases[variant]

  // Real variant passes through
  return variant
}

function parseRefString(input: string): ResolvedRef {
  const providerEnd = input.indexOf("/")
  if (providerEnd <= 0) {
    throw new Error(`Invalid model reference: ${input}`)
  }
  const providerID = input.slice(0, providerEnd)
  const variantStart = input.indexOf("#", providerEnd + 1)
  const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)
  if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#")))) {
    throw new Error(`Invalid model reference: ${input}`)
  }
  const ref = variant ? `${providerID}/${id}#${variant}` : `${providerID}/${id}`
  return {
    providerID,
    id,
    variant,
    ref,
  }
}

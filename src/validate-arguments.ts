/**
 * Check the arguments of a tool call against the schema the tool publishes.
 *
 * The schema is what a client is told, and the handlers read their arguments with type
 * assertions, which check nothing when the call arrives. A value of the wrong type therefore
 * used to travel on into a request to BW, or was passed over without a word. The published
 * schema is enforced here, before a handler runs: type, required parameters, enumerations and
 * the shape of nested objects and lists.
 *
 * Nothing is converted. A caller that sends a number as text is told so and can send it again;
 * a guess at what was meant would hide the mistake from the caller and from the log.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

interface ToolSchema {
  name: string;
  inputSchema: { properties?: Record<string, unknown>; [key: string]: unknown };
}

// Not strict: the schemas carry descriptive keywords a validator does not know.
const ajv = new Ajv({ strict: false, allErrors: true });
const compiled = new Map<string, ValidateFunction>();

function validatorFor(tool: ToolSchema): ValidateFunction {
  let validate = compiled.get(tool.name);
  if (!validate) {
    validate = ajv.compile(tool.inputSchema);
    compiled.set(tool.name, validate);
  }
  return validate;
}

function allowsNull(schema: unknown): boolean {
  const type = (schema as { type?: unknown } | undefined)?.type;
  return type === 'null' || (Array.isArray(type) && type.includes('null'));
}

/**
 * The arguments without the parameters passed as null. Clients fill parameters they do not
 * use with null, which says the same as leaving them out. A parameter whose schema names null
 * keeps it.
 */
export function withoutNulls(
  tool: ToolSchema | undefined,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!tool || !args) return args;
  const properties = tool.inputSchema.properties ?? {};
  const kept = Object.entries(args).filter(([key, value]) => value !== null || allowsNull(properties[key]));
  return kept.length === Object.keys(args).length ? args : Object.fromEntries(kept);
}

function shown(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function valueAt(args: unknown, path: string): unknown {
  let current = args;
  for (const part of path.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current;
}

function explain(error: ErrorObject, args: unknown): string {
  const where = error.instancePath ? error.instancePath.slice(1).replace(/\//g, '.') : '';
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required':
      return `${where ? `${where}.` : ''}${String(params.missingProperty)} is required`;
    case 'type':
      return `${where} must be ${String(params.type)}, got ${shown(valueAt(args, error.instancePath))}`;
    case 'enum':
      return `${where} must be one of ${(params.allowedValues as unknown[]).map(shown).join(', ')}, got ${shown(valueAt(args, error.instancePath))}`;
    case 'additionalProperties':
      return `${where ? `${where}.` : ''}${String(params.additionalProperty)} is not a parameter here`;
    default:
      return `${where || 'arguments'} ${error.message ?? 'is invalid'}`;
  }
}

/**
 * The refusal for arguments that do not match the tool's schema, or undefined when they do.
 * At most five findings are named: one mistake in a nested list repeats for every element.
 */
export function invalidArguments(
  tool: ToolSchema | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!tool) return undefined;
  const validate = validatorFor(tool);
  const value = args ?? {};
  if (validate(value)) return undefined;
  const findings = [...new Set((validate.errors ?? []).map((e) => explain(e, value)))];
  const more = findings.length > 5 ? `; and ${findings.length - 5} more` : '';
  return (
    `${tool.name} was not called, its arguments do not match the tool definition: ` +
    `${findings.slice(0, 5).join('; ')}${more}.`
  );
}

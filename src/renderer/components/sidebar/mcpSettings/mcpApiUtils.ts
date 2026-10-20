import type {
  McpApiEndpointDraft,
  McpApiParamDraft,
  McpApiSpecDraft,
  McpKeyValuePair,
} from "./types";

export const API_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
export const API_BODY_TYPES = ["none", "json", "form", "multipart", "raw"];
export const API_PARAM_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
];
export const API_PARAM_LOCATIONS = ["query", "path", "header", "body"];

const createApiItemId = (): string =>
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// 本文件不依赖 mcpSettingsUtils，避免循环引用
export const createApiPair = (key = "", value = ""): McpKeyValuePair => ({
  id: createApiItemId(),
  key,
  value,
});

export const createApiParam = (
  patch: Partial<McpApiParamDraft> = {},
): McpApiParamDraft => ({
  id: createApiItemId(),
  name: "",
  type: "string",
  required: false,
  description: "",
  location: "query",
  defaultValue: "",
  ...patch,
});

export const createApiEndpoint = (
  patch: Partial<McpApiEndpointDraft> = {},
): McpApiEndpointDraft => ({
  id: createApiItemId(),
  name: "",
  description: "",
  method: "GET",
  path: "",
  headers: [],
  params: [],
  bodyType: "none",
  bodyTemplate: "",
  rawContentType: "",
  ...patch,
});

export const createEmptyApiSpec = (): McpApiSpecDraft => ({
  cookies: [],
  endpoints: [],
});

/** 支持模板的请求体类型。 */
export const isTemplateBodyType = (bodyType: string): boolean =>
  bodyType === "json" || bodyType === "form" || bodyType === "raw";

/** 按位置为 Body 的参数生成请求体模板。 */
export const buildBodyTemplate = (
  params: McpApiParamDraft[],
  bodyType: string,
): string => {
  const names = params
    .filter((param) => param.location === "body")
    .map((param) => param.name.trim())
    .filter(Boolean);
  switch (bodyType) {
    case "json":
      return names.length === 0
        ? "{}"
        : `{\n${names
            .map((name) => `  ${JSON.stringify(name)}: "{{${name}}}"`)
            .join(",\n")}\n}`;
    case "form":
      return names.map((name) => `${name}={{${name}}}`).join("&");
    case "raw":
      return names.map((name) => `{{${name}}}`).join("\n");
    default:
      return "";
  }
};

/** 模板为空或仍是自动生成内容时，视为可随参数自动同步。 */
export const isAutoBodyTemplate = (endpoint: McpApiEndpointDraft): boolean =>
  !endpoint.bodyTemplate.trim() ||
  endpoint.bodyTemplate ===
    buildBodyTemplate(endpoint.params, endpoint.bodyType);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";

const pairsFromValue = (value: unknown): McpKeyValuePair[] =>
  isRecord(value)
    ? Object.entries(value).map(([key, item]) =>
        createApiPair(key, asText(item)),
      )
    : [];

const pairsToObject = (pairs: McpKeyValuePair[]): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key) {
      result[key] = pair.value;
    }
  }
  return result;
};

const pickOption = (value: unknown, options: string[], fallback: string) => {
  const text = asText(value).trim().toLowerCase();
  const matched = options.find((option) => option.toLowerCase() === text);
  return matched ?? fallback;
};

/** 从任意 JSON 值容错解析接口定义（JSON 编辑模式与持久化共用）。 */
export const apiSpecFromValue = (value: unknown): McpApiSpecDraft => {
  if (!isRecord(value)) {
    return createEmptyApiSpec();
  }
  const endpoints = Array.isArray(value.endpoints) ? value.endpoints : [];
  return {
    cookies: pairsFromValue(value.cookies),
    endpoints: endpoints.filter(isRecord).map((endpoint) => {
      const params = (Array.isArray(endpoint.params) ? endpoint.params : [])
        .filter(isRecord)
        .map((param) =>
          createApiParam({
            name: asText(param.name),
            type: pickOption(param.type, API_PARAM_TYPES, "string"),
            required: param.required === true,
            description: asText(param.description),
            location: pickOption(param.location, API_PARAM_LOCATIONS, "query"),
            defaultValue: asText(param.defaultValue),
          }),
        );
      const bodyType = pickOption(endpoint.bodyType, API_BODY_TYPES, "none");
      const bodyTemplate = asText(endpoint.bodyTemplate);
      return createApiEndpoint({
        name: asText(endpoint.name),
        description: asText(endpoint.description),
        method: pickOption(endpoint.method, API_METHODS, "GET"),
        path: asText(endpoint.path),
        headers: pairsFromValue(endpoint.headers),
        params,
        bodyType,
        // 旧配置留空模板时补全为可见模板（json/form 与留空语义一致）
        bodyTemplate:
          bodyTemplate.trim() || (bodyType !== "json" && bodyType !== "form")
            ? bodyTemplate
            : buildBodyTemplate(params, bodyType),
        rawContentType: asText(endpoint.rawContentType),
      });
    }),
  };
};

export const apiSpecFromJson = (argsJson: string): McpApiSpecDraft => {
  try {
    return apiSpecFromValue(JSON.parse(argsJson || "{}"));
  } catch {
    return createEmptyApiSpec();
  }
};

/** 序列化为持久化结构（去掉 UI id）。 */
export const apiSpecToObject = (
  spec: McpApiSpecDraft,
): Record<string, unknown> => ({
  cookies: pairsToObject(spec.cookies),
  endpoints: spec.endpoints.map((endpoint) => ({
    name: endpoint.name.trim(),
    description: endpoint.description.trim(),
    method: endpoint.method,
    path: endpoint.path.trim(),
    headers: pairsToObject(endpoint.headers),
    params: endpoint.params
      .filter((param) => param.name.trim())
      .map((param) => ({
        name: param.name.trim(),
        type: param.type,
        required: param.required,
        description: param.description.trim(),
        location: param.location,
        defaultValue: param.defaultValue,
      })),
    bodyType: endpoint.bodyType,
    bodyTemplate: endpoint.bodyTemplate,
    rawContentType: endpoint.rawContentType.trim(),
  })),
});

export const apiSpecToJson = (spec: McpApiSpecDraft): string =>
  JSON.stringify(apiSpecToObject(spec));

export type McpApiValidationError = {
  key: string;
  defaultValue: string;
  values?: Record<string, string | number>;
};

const hasDuplicate = (values: string[]): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      return value;
    }
    seen.add(normalized);
  }
  return null;
};

/** 保存前校验接口定义，返回首个错误。 */
export const validateApiSpec = (
  spec: McpApiSpecDraft,
): McpApiValidationError | null => {
  if (spec.endpoints.length === 0) {
    return {
      key: "settings.mcpApiNoEndpointsError",
      defaultValue: "Add at least one API endpoint.",
    };
  }
  const names: string[] = [];
  for (const [index, endpoint] of spec.endpoints.entries()) {
    const name = endpoint.name.trim();
    if (!name) {
      return {
        key: "settings.mcpApiEndpointNameRequired",
        defaultValue: "Endpoint #{{index}} needs a tool name.",
        values: { index: index + 1 },
      };
    }
    names.push(name);
    const duplicateParam = hasDuplicate(
      endpoint.params.map((param) => param.name.trim()).filter(Boolean),
    );
    if (duplicateParam) {
      return {
        key: "settings.mcpApiDuplicateParam",
        defaultValue:
          'Endpoint "{{name}}" has duplicate parameter "{{param}}".',
        values: { name, param: duplicateParam },
      };
    }
  }
  const duplicateName = hasDuplicate(names);
  if (duplicateName) {
    return {
      key: "settings.mcpApiDuplicateEndpoint",
      defaultValue: 'Tool name "{{name}}" is used by more than one endpoint.',
      values: { name: duplicateName },
    };
  }
  return null;
};

/** 按参数类型把测试输入转换为调用参数，空值不传。 */
export const buildTestArguments = (
  params: McpApiParamDraft[],
  inputs: Record<string, string>,
): { args: Record<string, unknown> } | { error: string } => {
  const args: Record<string, unknown> = {};
  for (const param of params) {
    const name = param.name.trim();
    const raw = (inputs[param.id] ?? "").trim();
    if (!name || !raw) {
      continue;
    }
    if (param.type === "number" || param.type === "integer") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return { error: name };
      }
      args[name] = value;
    } else if (param.type === "boolean") {
      args[name] = raw === "true";
    } else if (param.type === "object" || param.type === "array") {
      try {
        args[name] = JSON.parse(raw);
      } catch {
        return { error: name };
      }
    } else {
      args[name] = raw;
    }
  }
  return { args };
};

import type { Locale } from "../../shared/locale";
import { resolveMetadataDomainEntry } from "./metadata/catalog";
import { METADATA_DOMAINS } from "./metadata/domains";
import type { SensitiveScope } from "./types";
import { WRITE_ACTIONS } from "./writes/domains";

/** 某个隐私域放行的可读元数据域。 */
export type PrivacyMetadataEntry = {
  id: string;
  summary: string;
  /** 字段级敏感命中的字段名；整域敏感时为空数组。 */
  fields: string[];
};

/** 某个隐私域放行的可写能力（按写域聚合）。 */
export type PrivacyWriteDomainEntry = {
  domain: string;
  count: number;
};

export type PrivacyScopeDescription = {
  scope: SensitiveScope;
  metadata: PrivacyMetadataEntry[];
  writeDomains: PrivacyWriteDomainEntry[];
  writeCount: number;
};

/** 按隐私域汇总该域放行的元数据域与写动作（面板徽章详情用）。 */
export const describePrivacyScopes = (
  scopes: readonly SensitiveScope[],
  locale: Locale,
): PrivacyScopeDescription[] => {
  const metadataByScope = new Map<
    SensitiveScope,
    Map<string, PrivacyMetadataEntry>
  >();

  for (const definition of METADATA_DOMAINS) {
    const summary = resolveMetadataDomainEntry(definition.id).summary[locale];
    const fieldsByScope = new Map<SensitiveScope, string[]>();
    if (definition.scope) {
      fieldsByScope.set(definition.scope, []);
    }
    for (const [field, scope] of Object.entries(
      definition.sensitiveFields ?? {},
    )) {
      const fields = fieldsByScope.get(scope) ?? [];
      fields.push(field);
      fieldsByScope.set(scope, fields);
    }

    for (const [scope, fields] of fieldsByScope) {
      let entries = metadataByScope.get(scope);
      if (!entries) {
        entries = new Map<string, PrivacyMetadataEntry>();
        metadataByScope.set(scope, entries);
      }
      const existing = entries.get(definition.id);
      if (existing) {
        for (const field of fields) {
          if (!existing.fields.includes(field)) {
            existing.fields.push(field);
          }
        }
        continue;
      }
      entries.set(definition.id, {
        id: definition.id,
        summary,
        fields: [...fields],
      });
    }
  }

  const writeByScope = new Map<SensitiveScope, Map<string, number>>();
  for (const definition of WRITE_ACTIONS) {
    if (!definition.scope) {
      continue;
    }
    let domains = writeByScope.get(definition.scope);
    if (!domains) {
      domains = new Map<string, number>();
      writeByScope.set(definition.scope, domains);
    }
    domains.set(definition.domain, (domains.get(definition.domain) ?? 0) + 1);
  }

  return Array.from(new Set(scopes)).map((scope) => {
    const metadata = Array.from(metadataByScope.get(scope)?.values() ?? []);
    const writeDomains = Array.from(writeByScope.get(scope) ?? []).map(
      ([domain, count]) => ({ domain, count }),
    );
    return {
      scope,
      metadata,
      writeDomains,
      writeCount: writeDomains.reduce((total, item) => total + item.count, 0),
    };
  });
};

import { Mapping, Row, ComparisonOperator } from "./types";

function evaluateComparison(value: unknown, operator: ComparisonOperator, target?: string) {
  const strValue = value == null ? "" : String(value);
  const targetValue = target ?? "";
  switch (operator) {
    case "equals":
      return strValue === targetValue;
    case "notEquals":
      return strValue !== targetValue;
    case "contains":
      return strValue.includes(targetValue);
    case "startsWith":
      return strValue.startsWith(targetValue);
    case "endsWith":
      return strValue.endsWith(targetValue);
    case "greaterThan": {
      const a = Number(value);
      const b = Number(targetValue);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return a > b;
    }
    case "lessThan": {
      const a = Number(value);
      const b = Number(targetValue);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return a < b;
    }
    case "isEmpty":
      return strValue.trim().length === 0;
    case "isNotEmpty":
      return strValue.trim().length > 0;
    default:
      return false;
  }
}

function castValue(v: unknown, cast?: string) {
  if (v == null || !cast) return v;
  const normalized = cast.toUpperCase();
  if (normalized.includes("INT")) return Number.parseInt(String(v), 10);
  if (
    normalized.includes("DECIMAL") ||
    normalized.includes("FLOAT") ||
    normalized.includes("DOUBLE") ||
    normalized === "NUMBER"
  ) {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  if (normalized.includes("BOOL")) {
    const s = String(v).toLowerCase();
    if (["true", "t", "1", "yes", "y"].includes(s)) return true;
    if (["false", "f", "0", "no", "n"].includes(s)) return false;
    return null;
  }
  if (normalized.includes("DATE") || normalized.includes("TIME")) {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return String(v);
}

export function applyMapping(rows: Row[], mapping: Mapping): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const m of mapping) {
      let raw: unknown;
      if (m.concat && Array.isArray(m.concat.sources) && m.concat.sources.length) {
        const separator = m.concat.separator ?? "";
        raw = m.concat.sources.map((source) => r[source] ?? "").join(separator);
      } else {
        raw = r[m.from];
      }

      if (m.split && raw != null) {
        const parts = String(raw).split(m.split.delimiter ?? "");
        raw = parts[m.split.partIndex] ?? "";
      }

      if (m.condition) {
        const comparisonField =
          m.condition.field && m.condition.field in r ? m.condition.field : m.from;
        const comparisonValue = r[comparisonField];
        const matches = evaluateComparison(comparisonValue, m.condition.operator, m.condition.value);
        if (matches && m.condition.thenValue !== undefined) {
          raw = m.condition.thenValue;
        } else if (!matches && m.condition.elseValue !== undefined) {
          raw = m.condition.elseValue;
        }
      }

      if (m.trim && typeof raw === "string") {
        raw = raw.trim();
      }
      out[m.to] = castValue(raw, m.cast);
    }
    return out;
  });
}

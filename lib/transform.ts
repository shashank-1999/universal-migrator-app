import { Mapping, Row } from "./types";

export function applyMapping(rows: Row[], mapping: Mapping): Row[] {
  // order columns by mapping sequence
  return rows.map((r) => {
    const out: Row = {};
    for (const m of mapping) {
      let v = r[m.from];
      // basic casts (expand as you like)
      if (v != null && m.cast) {
        const c = m.cast.toUpperCase();
        if (c.includes("INT")) v = Number.parseInt(String(v));
        else if (c.includes("DECIMAL") || c.includes("FLOAT") || c.includes("DOUBLE")) v = Number(v);
        else if (c.includes("BOOL")) v = String(v).toLowerCase() === "true" ? true : Number(v) === 1;
        else if (c.includes("DATE") || c.includes("TIME")) v = new Date(v);
        else v = String(v);
      }
      out[m.to] = v;
    }
    return out;
  });
}

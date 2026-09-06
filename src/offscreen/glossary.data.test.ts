import {
  describe,
  expect,
  it,
} from "vitest";

import {
  NAME_TERMS,
} from "./glossary.data";

describe("NAME_TERMS", () => {
  it("keeps every row sourced and internally valid", () => {
    const seen = new Set<string>();

    for (const entry of NAME_TERMS) {
      expect(entry.source.trim()).not.toBe("");

      if (entry.render === "ja") {
        expect(entry.ja?.trim()).not.toBe("");
        expect(entry.source).toMatch(/^https:\/\//u);
      }

      const key = entry.term.toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);

      for (const rejected of entry.rejected ?? []) {
        expect(rejected.form.trim()).not.toBe("");
        expect(rejected.reason.trim()).not.toBe("");
        expect(rejected.form).not.toBe(entry.term);
        expect(rejected.form).not.toBe(entry.ja);
      }
    }
  });
});

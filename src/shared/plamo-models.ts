export const PLAMO_CONTEXT_TOKENS = 4096;

export const PLAMO_MODELS = {
  "0.8b": {
    repo: "pfnet/plamo-3-translate-0.8b-GGUF",
    revision: "e10c327b7a7ce84ffc427cb4b09360b781429fda",
    file: "plamo-3-translate-0.8b-Q4_K_M.gguf",
    bytes: 573126848,
    sha256: "70891ec70dc7ab4205745a38307867c2881b99239f20327927633abfe4bc9ec6",
  },
  "2b": {
    repo: "pfnet/plamo-3-translate-2b-GGUF",
    revision: "228a27cc0bb4f111219963848d50a3127c16ca73",
    file: "plamo-3-translate-2b-Q4_K_M.gguf",
    bytes: 1807203040,
    sha256: "1ffd9073afcc70e35ccc942428aa2b73d7aa2b9ea779bf504b775369e0276c13",
  },
  "8b": {
    repo: "pfnet/plamo-3-translate-8b-GGUF",
    revision: "fccc6b15efc7d615189fa5df6a1a02ecd2dbc18f",
    file: "plamo-3-translate-8b-Q4_K_M.gguf",
    bytes: 5280445728,
    sha256: "94e5d3f91b421f7c8900ddaac27b11a19f7441426c954bbb25a2fd60a1640187",
  },
} as const;

export type PlamoModel = keyof typeof PLAMO_MODELS;

export function isPlamoModel(value: unknown): value is PlamoModel {
  return value === "0.8b" || value === "2b" || value === "8b";
}

export function plamoModelUrl(model: PlamoModel): string {
  const entry = PLAMO_MODELS[model];
  return `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`;
}

export declare const GEMINI_TOP_MODEL: "gemini-4-neon";
export declare const GEMINI_CHEAP_MODEL: "gemini-3.8-flash";
export declare const RETIRED_MODEL_IDS: Readonly<Record<string, string>>;
export declare function migrateModelId<T>(model: T): T;
export declare const AGY_CLAUDE_FAMILY: "agy-claude";
export declare const AGY_CLAUDE_TOP_MODEL: "claude-opus-5-5-high";
export declare const AGY_CLAUDE_MID_MODEL: "claude-sonnet-5-5-medium";
export declare const AGY_CLAUDE_SUFFIXED_RE: RegExp;
export declare function isAgyClaudeModel(model: unknown): boolean;

export declare const GEMINI_TOP_MODEL: "gemini-4-neon";
export declare const GEMINI_CHEAP_MODEL: "gemini-3.8-flash";
export declare const RETIRED_MODEL_IDS: Readonly<Record<string, string>>;
export declare function migrateModelId<T>(model: T): T;

export const LESSONS_BEGIN: string;
export const LESSONS_END: string;
export const vibesquadHome: () => string;
export function resolveLessonsStorePath(rootDir?: string): string;
export function stripBom(raw: unknown): string;
export function normalizeLesson(entry: unknown): LessonEntry;
export function appendLesson(entry: unknown, opts?: { storePath?: string; rootDir?: string }): LessonEntry;
export function readLessons(opts?: {
  category?: string;
  query?: string;
  limit?: number;
  storePath?: string;
  rootDir?: string;
}): LessonEntry[];
export function renderLessonsDigest(opts?: {
  limit?: number;
  storePath?: string;
  rootDir?: string;
}): string;
export const STANDING_RULES: string[];

export interface LessonEntry {
  id: string;
  category: string;
  title: string;
  cause: string;
  rule: string;
  refs?: string[];
  tags?: string[];
  createdAt: string;
}

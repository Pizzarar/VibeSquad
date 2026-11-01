import { useCallback, useSyncExternalStore } from "react";

// Unsent composer images. Blobs live in IndexedDB (survive reloads); an in-memory cache with object-URL
// previews makes tab switches instant. Subscribers are per key, so only that composer re-renders.
const DB_NAME = "vs-drafts-idb";
const STORE = "images";

export type DraftImage = { id: string; name: string; mimeType: string; blob: Blob; createdAt: number };
export type DraftImageView = DraftImage & { url: string };

const mem = new Map<string, DraftImageView[]>();
const loaded = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: DraftImageView[] = [];

let dbPromise: Promise<IDBDatabase> | undefined;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(key: string): Promise<DraftImage[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as DraftImage[] | undefined) ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, items: DraftImage[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    if (items.length) os.put(items, key);
    else os.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

function persist(key: string) {
  const items = (mem.get(key) ?? []).map(({ url: _u, ...rest }) => rest);
  idbPut(key, items).catch(() => {
    /* storage unavailable: memory copy still works */
  });
}

function load(key: string) {
  if (loaded.has(key)) return;
  loaded.add(key);
  idbGet(key)
    .then((items) => {
      // Anything added while the read was in flight wins; merge stored items in front.
      const cur = mem.get(key) ?? [];
      const have = new Set(cur.map((i) => i.id));
      const stored = items.filter((i) => !have.has(i.id)).map((i) => ({ ...i, url: URL.createObjectURL(i.blob) }));
      if (stored.length) {
        mem.set(key, [...stored, ...cur]);
        emit(key);
      }
    })
    .catch(() => {});
}

function subscribe(key: string, cb: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

export function addImages(key: string, files: Array<File | Blob>) {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return;
  const now = Date.now();
  const added: DraftImageView[] = imgs.map((f, i) => ({
    id: `${now}-${Math.random().toString(36).slice(2, 8)}-${i}`,
    name: (f as File).name || `pasted-${new Date(now).toISOString().slice(11, 19).replace(/:/g, "")}.${f.type.split("/")[1] || "png"}`,
    mimeType: f.type,
    blob: f,
    createdAt: now,
    url: URL.createObjectURL(f),
  }));
  mem.set(key, [...(mem.get(key) ?? []), ...added]);
  emit(key);
  persist(key);
}

export function removeImage(key: string, id: string) {
  const cur = mem.get(key) ?? [];
  const gone = cur.find((i) => i.id === id);
  if (!gone) return;
  URL.revokeObjectURL(gone.url);
  mem.set(key, cur.filter((i) => i.id !== id));
  emit(key);
  persist(key);
}

export function clearImages(key: string) {
  for (const i of mem.get(key) ?? []) URL.revokeObjectURL(i.url);
  mem.delete(key);
  emit(key);
  persist(key);
}

export function useImageDraft(key: string) {
  load(key);
  const images = useSyncExternalStore(
    useCallback((cb) => subscribe(key, cb), [key]),
    () => mem.get(key) ?? EMPTY,
  );
  return {
    images,
    add: useCallback((files: Array<File | Blob>) => addImages(key, files), [key]),
    remove: useCallback((id: string) => removeImage(key, id), [key]),
    clear: useCallback(() => clearImages(key), [key]),
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function blobsToPaseoImages(items: Array<{ blob: Blob }>): Promise<Array<{ data: string; mimeType: string }>> {
  return Promise.all(items.map(async (i) => ({ data: await blobToBase64(i.blob), mimeType: i.blob.type || "image/png" })));
}

// Images we sent, remembered by message text so the timeline can show thumbnails (the daemon's
// user_message items carry text only). Object URLs are kept for the page lifetime.
const sent = new Map<string, Array<{ text: string; urls: string[] }>>();

export function rememberSent(agentId: string, text: string, items: Array<{ blob: Blob }>) {
  const list = sent.get(agentId) ?? [];
  list.push({ text, urls: items.map((i) => URL.createObjectURL(i.blob)) });
  sent.set(agentId, list.slice(-20));
}

export function sentImagesFor(agentId: string, text: string): string[] {
  const list = sent.get(agentId);
  if (!list) return EMPTY as unknown as string[];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].text === text) return list[i].urls;
  return EMPTY as unknown as string[];
}

import { useEffect, useState } from "react";

export type ActionType =
  | "accept_order"
  | "accept_ride"
  | "update_order"
  | "update_ride"
  | "complete_trip"
  | "board_passenger";

export interface QueuedAction {
  id: string;
  type: ActionType;
  entityId: string;
  payload: Record<string, unknown>;
  retryCount: number;
  createdAt: number;
}

const DB_NAME = "ajkmart_action_queue";
const STORE = "actions";
const DB_VER = 1;

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { _dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch {} _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  }).catch(err => { _dbPromise = null; throw err; });
  return _dbPromise;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueAction(
  type: ActionType,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const action: QueuedAction = {
    id: generateId(),
    type,
    entityId,
    payload,
    retryCount: 0,
    createdAt: Date.now(),
  };
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(action);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    notifyListeners();
  } catch { /* best-effort — swallow on unavailable storage */ }
  return action.id;
}

async function getAll(): Promise<QueuedAction[]> {
  try {
    const db = await openDB();
    const all = await new Promise<QueuedAction[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as QueuedAction[]);
      req.onerror = () => reject(req.error);
    });
    /* Sort strictly FIFO by creation time so status transitions replay in the
       correct order (e.g. accepted → in_transit → completed, never reversed). */
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch { return []; }
}

async function removeAction(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

async function bumpRetryCount(action: QueuedAction): Promise<void> {
  try {
    const db = await openDB();
    const updated: QueuedAction = { ...action, retryCount: action.retryCount + 1 };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(updated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

type ActionExecutor = (action: QueuedAction) => Promise<void>;

let _executor: ActionExecutor | null = null;
let _syncing = false;
let _lastSync: number | null = null;

export function registerActionExecutor(fn: ActionExecutor): void {
  _executor = fn;
}

type ActionSuccessCallback = (action: QueuedAction) => void;
const _successCallbacks = new Map<ActionType, Set<ActionSuccessCallback>>();

export function subscribeActionSuccess(type: ActionType, fn: ActionSuccessCallback): () => void {
  if (!_successCallbacks.has(type)) _successCallbacks.set(type, new Set());
  _successCallbacks.get(type)!.add(fn);
  return () => { _successCallbacks.get(type)?.delete(fn); };
}

function notifyActionSuccess(action: QueuedAction): void {
  _successCallbacks.get(action.type)?.forEach(fn => { try { fn(action); } catch {} });
}

export async function syncQueue(): Promise<void> {
  if (_syncing || !_executor) return;
  _syncing = true;
  notifyListeners();
  try {
    const actions = await getAll();
    if (actions.length === 0) return;
    /* Process strictly in createdAt order. Stop the drain when any action
       fails — a failed predecessor (e.g. accept_order) must not be skipped,
       because later actions (update_order, complete_trip) depend on it
       having succeeded server-side first. */
    for (const action of actions) {
      try {
        await _executor(action);
        await removeAction(action.id);
        notifyActionSuccess(action);
      } catch {
        await bumpRetryCount(action).catch(() => {});
        break; /* stop here; retry next sync cycle to preserve ordering */
      }
    }
    _lastSync = Date.now();
  } finally {
    _syncing = false;
    notifyListeners();
  }
}

type Listener = () => void;
const _listeners = new Set<Listener>();

function notifyListeners() {
  _listeners.forEach(fn => fn());
}

export function subscribeQueueStatus(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export async function getQueuePendingCount(): Promise<number> {
  const actions = await getAll();
  return actions.length;
}

export function useQueueStatus() {
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState<number | null>(_lastSync);
  const [syncing, setSyncing] = useState(_syncing);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const count = await getQueuePendingCount();
      if (mounted) {
        setPendingCount(count);
        setLastSync(_lastSync);
        setSyncing(_syncing);
      }
    };
    refresh();
    const unsub = subscribeQueueStatus(refresh);
    return () => { mounted = false; unsub(); };
  }, []);

  return { pendingCount, lastSync, syncing };
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { syncQueue().catch(() => {}); });
  /* Periodic retry every 30 seconds — covers Android WebViews that skip the
     `online` event, and any OS where the event fires unreliably after roaming. */
  setInterval(() => {
    if (navigator.onLine) { syncQueue().catch(() => {}); }
  }, 30_000);
}

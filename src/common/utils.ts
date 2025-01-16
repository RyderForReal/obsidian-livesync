import { normalizePath, Platform, TAbstractFile, type RequestUrlParam, requestUrl } from "../deps.ts";
import {
    path2id_base,
    id2path_base,
    isValidFilenameInLinux,
    isValidFilenameInDarwin,
    isValidFilenameInWidows,
    isValidFilenameInAndroid,
    stripAllPrefixes,
} from "../lib/src/string_and_binary/path.ts";

import { Logger } from "../lib/src/common/logger.ts";
import {
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type AnyEntry,
    type DocumentID,
    type EntryHasPath,
    type FilePath,
    type FilePathWithPrefix,
    type UXFileInfo,
    type UXFileInfoStub,
} from "../lib/src/common/types.ts";
import { CHeader, ICHeader, ICHeaderLength, ICXHeader, PSCHeader } from "./types.ts";
import type ObsidianLiveSyncPlugin from "../main.ts";
import { writeString } from "../lib/src/string_and_binary/convert.ts";
import { fireAndForget } from "../lib/src/common/utils.ts";
import { sameChangePairs } from "./stores.ts";
import type { KeyValueDatabase } from "./KeyValueDB.ts";
import { scheduleTask } from "octagonal-wheels/concurrency/task";
import { EVENT_PLUGIN_UNLOADED, eventHub } from "./events.ts";

export { scheduleTask, cancelTask, cancelAllTasks } from "../lib/src/concurrency/task.ts";

// For backward compatibility, using the path for determining id.
// Only CouchDB unacceptable ID (that starts with an underscore) has been prefixed with "/".
// The first slash will be deleted when the path is normalized.
export async function path2id(
    filename: FilePathWithPrefix | FilePath,
    obfuscatePassphrase: string | false,
    caseInsensitive: boolean
): Promise<DocumentID> {
    const temp = filename.split(":");
    const path = temp.pop();
    const normalizedPath = normalizePath(path as FilePath);
    temp.push(normalizedPath);
    const fixedPath = temp.join(":") as FilePathWithPrefix;

    const out = await path2id_base(fixedPath, obfuscatePassphrase, caseInsensitive);
    return out;
}
export function id2path(id: DocumentID, entry?: EntryHasPath): FilePathWithPrefix {
    const filename = id2path_base(id, entry);
    const temp = filename.split(":");
    const path = temp.pop();
    const normalizedPath = normalizePath(path as FilePath);
    temp.push(normalizedPath);
    const fixedPath = temp.join(":") as FilePathWithPrefix;
    return fixedPath;
}
export function getPath(entry: AnyEntry) {
    return id2path(entry._id, entry);
}
export function getPathWithoutPrefix(entry: AnyEntry) {
    const f = getPath(entry);
    return stripAllPrefixes(f);
}

export function getPathFromTFile(file: TAbstractFile) {
    return file.path as FilePath;
}

export function isInternalFile(file: UXFileInfoStub | string | FilePathWithPrefix) {
    if (typeof file == "string") return file.startsWith(ICHeader);
    if (file.isInternal) return true;
    return false;
}
export function getPathFromUXFileInfo(file: UXFileInfoStub | string | FilePathWithPrefix) {
    if (typeof file == "string") return file as FilePathWithPrefix;
    return file.path;
}
export function getStoragePathFromUXFileInfo(file: UXFileInfoStub | string | FilePathWithPrefix) {
    if (typeof file == "string") return stripAllPrefixes(file as FilePathWithPrefix);
    return stripAllPrefixes(file.path);
}
export function getDatabasePathFromUXFileInfo(file: UXFileInfoStub | string | FilePathWithPrefix) {
    if (typeof file == "string" && file.startsWith(ICXHeader)) return file as FilePathWithPrefix;
    const prefix = isInternalFile(file) ? ICHeader : "";
    if (typeof file == "string") return (prefix + stripAllPrefixes(file as FilePathWithPrefix)) as FilePathWithPrefix;
    return (prefix + stripAllPrefixes(file.path)) as FilePathWithPrefix;
}

const memos: { [key: string]: any } = {};
export function memoObject<T>(key: string, obj: T): T {
    memos[key] = obj;
    return memos[key] as T;
}
export async function memoIfNotExist<T>(key: string, func: () => T | Promise<T>): Promise<T> {
    if (!(key in memos)) {
        const w = func();
        const v = w instanceof Promise ? await w : w;
        memos[key] = v;
    }
    return memos[key] as T;
}
export function retrieveMemoObject<T>(key: string): T | false {
    if (key in memos) {
        return memos[key];
    } else {
        return false;
    }
}
export function disposeMemoObject(key: string) {
    delete memos[key];
}

export function isValidPath(filename: string) {
    if (Platform.isDesktop) {
        // if(Platform.isMacOS) return isValidFilenameInDarwin(filename);
        if (process.platform == "darwin") return isValidFilenameInDarwin(filename);
        if (process.platform == "linux") return isValidFilenameInLinux(filename);
        return isValidFilenameInWidows(filename);
    }
    if (Platform.isAndroidApp) return isValidFilenameInAndroid(filename);
    if (Platform.isIosApp) return isValidFilenameInDarwin(filename);
    //Fallback
    Logger("Could not determine platform for checking filename", LOG_LEVEL_VERBOSE);
    return isValidFilenameInWidows(filename);
}

export function trimPrefix(target: string, prefix: string) {
    return target.startsWith(prefix) ? target.substring(prefix.length) : target;
}

/**
 * returns is internal chunk of file
 * @param id ID
 * @returns
 */
export function isInternalMetadata(id: FilePath | FilePathWithPrefix | DocumentID): boolean {
    return id.startsWith(ICHeader);
}
export function stripInternalMetadataPrefix<T extends FilePath | FilePathWithPrefix | DocumentID>(id: T): T {
    return id.substring(ICHeaderLength) as T;
}
export function id2InternalMetadataId(id: DocumentID): DocumentID {
    return (ICHeader + id) as DocumentID;
}

// const CHeaderLength = CHeader.length;
export function isChunk(str: string): boolean {
    return str.startsWith(CHeader);
}

export function isPluginMetadata(str: string): boolean {
    return str.startsWith(PSCHeader);
}
export function isCustomisationSyncMetadata(str: string): boolean {
    return str.startsWith(ICXHeader);
}

export class PeriodicProcessor {
    _process: () => Promise<any>;
    _timer?: number = undefined;
    _plugin: ObsidianLiveSyncPlugin;
    constructor(plugin: ObsidianLiveSyncPlugin, process: () => Promise<any>) {
        this._plugin = plugin;
        this._process = process;
        eventHub.onceEvent(EVENT_PLUGIN_UNLOADED, () => {
            this.disable();
        });
    }
    async process() {
        try {
            await this._process();
        } catch (ex) {
            Logger(ex);
        }
    }
    enable(interval: number) {
        this.disable();
        if (interval == 0) return;
        this._timer = window.setInterval(
            () =>
                fireAndForget(async () => {
                    await this.process();
                    if (this._plugin.$$isUnloaded()) {
                        this.disable();
                    }
                }),
            interval
        );
        this._plugin.registerInterval(this._timer);
    }
    disable() {
        if (this._timer !== undefined) {
            window.clearInterval(this._timer);
            this._timer = undefined;
        }
    }
}

export const _requestToCouchDBFetch = async (
    baseUri: string,
    username: string,
    password: string,
    path?: string,
    body?: string | any,
    method?: string
) => {
    const utf8str = String.fromCharCode.apply(null, [...writeString(`${username}:${password}`)]);
    const encoded = window.btoa(utf8str);
    const authHeader = "Basic " + encoded;
    const transformedHeaders: Record<string, string> = {
        authorization: authHeader,
        "content-type": "application/json",
    };
    const uri = `${baseUri}/${path}`;
    const requestParam = {
        url: uri,
        method: method || (body ? "PUT" : "GET"),
        headers: new Headers(transformedHeaders),
        contentType: "application/json",
        body: JSON.stringify(body),
    };
    return await fetch(uri, requestParam);
};

export const _requestToCouchDB = async (
    baseUri: string,
    username: string,
    password: string,
    origin: string,
    path?: string,
    body?: any,
    method?: string
) => {
    const utf8str = String.fromCharCode.apply(null, [...writeString(`${username}:${password}`)]);
    const encoded = window.btoa(utf8str);
    const authHeader = "Basic " + encoded;
    const transformedHeaders: Record<string, string> = { authorization: authHeader, origin: origin };
    const uri = `${baseUri}/${path}`;
    const requestParam: RequestUrlParam = {
        url: uri,
        method: method || (body ? "PUT" : "GET"),
        headers: transformedHeaders,
        contentType: "application/json",
        body: body ? JSON.stringify(body) : undefined,
    };
    return await requestUrl(requestParam);
};
export const requestToCouchDB = async (
    baseUri: string,
    username: string,
    password: string,
    origin: string = "",
    key?: string,
    body?: string,
    method?: string
) => {
    const uri = `_node/_local/_config${key ? "/" + key : ""}`;
    return await _requestToCouchDB(baseUri, username, password, origin, uri, body, method);
};

export const BASE_IS_NEW = Symbol("base");
export const TARGET_IS_NEW = Symbol("target");
export const EVEN = Symbol("even");

// Why 2000? : ZIP FILE Does not have enough resolution.
const resolution = 2000;
export function compareMTime(
    baseMTime: number,
    targetMTime: number
): typeof BASE_IS_NEW | typeof TARGET_IS_NEW | typeof EVEN {
    const truncatedBaseMTime = ~~(baseMTime / resolution) * resolution;
    const truncatedTargetMTime = ~~(targetMTime / resolution) * resolution;
    // Logger(`Resolution MTime ${truncatedBaseMTime} and ${truncatedTargetMTime} `, LOG_LEVEL_VERBOSE);
    if (truncatedBaseMTime == truncatedTargetMTime) return EVEN;
    if (truncatedBaseMTime > truncatedTargetMTime) return BASE_IS_NEW;
    if (truncatedBaseMTime < truncatedTargetMTime) return TARGET_IS_NEW;
    throw new Error("Unexpected error");
}

function getKey(file: AnyEntry | string | UXFileInfoStub) {
    const key = typeof file == "string" ? file : stripAllPrefixes(file.path);
    return key;
}

export function markChangesAreSame(file: AnyEntry | string | UXFileInfoStub, mtime1: number, mtime2: number) {
    if (mtime1 === mtime2) return true;
    const key = getKey(file);
    const pairs = sameChangePairs.get(key, []) || [];
    if (pairs.some((e) => e == mtime1 || e == mtime2)) {
        sameChangePairs.set(key, [...new Set([...pairs, mtime1, mtime2])]);
    } else {
        sameChangePairs.set(key, [mtime1, mtime2]);
    }
}

export function unmarkChanges(file: AnyEntry | string | UXFileInfoStub) {
    const key = getKey(file);
    sameChangePairs.delete(key);
}
export function isMarkedAsSameChanges(file: UXFileInfoStub | AnyEntry | string, mtimes: number[]) {
    const key = getKey(file);
    const pairs = sameChangePairs.get(key, []) || [];
    if (mtimes.every((e) => pairs.indexOf(e) !== -1)) {
        return EVEN;
    }
}
export function compareFileFreshness(
    baseFile: UXFileInfoStub | AnyEntry | undefined,
    checkTarget: UXFileInfo | AnyEntry | undefined
): typeof BASE_IS_NEW | typeof TARGET_IS_NEW | typeof EVEN {
    if (baseFile === undefined && checkTarget == undefined) return EVEN;
    if (baseFile == undefined) return TARGET_IS_NEW;
    if (checkTarget == undefined) return BASE_IS_NEW;

    const modifiedBase = "stat" in baseFile ? (baseFile?.stat?.mtime ?? 0) : (baseFile?.mtime ?? 0);
    const modifiedTarget = "stat" in checkTarget ? (checkTarget?.stat?.mtime ?? 0) : (checkTarget?.mtime ?? 0);

    if (modifiedBase && modifiedTarget && isMarkedAsSameChanges(baseFile, [modifiedBase, modifiedTarget])) {
        return EVEN;
    }
    return compareMTime(modifiedBase, modifiedTarget);
}

const _cached = new Map<
    string,
    {
        value: any;
        context: Map<string, any>;
    }
>();

export type MemoOption = {
    key: string;
    forceUpdate?: boolean;
    validator?: (context: Map<string, any>) => boolean;
};

export function useMemo<T>(
    { key, forceUpdate, validator }: MemoOption,
    updateFunc: (context: Map<string, any>, prev: T) => T
): T {
    const cached = _cached.get(key);
    const context = cached?.context || new Map<string, any>();
    if (cached && !forceUpdate && (!validator || (validator && !validator(context)))) {
        return cached.value;
    }
    const value = updateFunc(context, cached?.value);
    if (value !== cached?.value) {
        _cached.set(key, { value, context });
    }
    return value;
}

// const _static = new Map<string, any>();
const _staticObj = new Map<
    string,
    {
        value: any;
    }
>();

export function useStatic<T>(key: string): { value: T | undefined };
export function useStatic<T>(key: string, initial: T): { value: T };
export function useStatic<T>(key: string, initial?: T) {
    // if (!_static.has(key) && initial) {
    //     _static.set(key, initial);
    // }
    const obj = _staticObj.get(key);
    if (obj !== undefined) {
        return obj;
    } else {
        // let buf = initial;
        const obj = {
            _buf: initial,
            get value() {
                return this._buf as T;
            },
            set value(value: T) {
                this._buf = value;
            },
        };
        _staticObj.set(key, obj);
        return obj;
    }
}
export function disposeMemo(key: string) {
    _cached.delete(key);
}

export function disposeAllMemo() {
    _cached.clear();
}

export function displayRev(rev: string) {
    const [number, hash] = rev.split("-");
    return `${number}-${hash.substring(0, 6)}`;
}

type DocumentProps = {
    id: DocumentID;
    rev?: string;
    prefixedPath: FilePathWithPrefix;
    path: FilePath;
    isDeleted: boolean;
    revDisplay: string;
    shortenedId: string;
    shortenedPath: string;
};

export function getDocProps(doc: AnyEntry): DocumentProps {
    const id = doc._id;
    const shortenedId = id.substring(0, 10);
    const prefixedPath = getPath(doc);
    const path = stripAllPrefixes(prefixedPath);
    const rev = doc._rev;
    const revDisplay = rev ? displayRev(rev) : "0-NOREVS";
    // const prefix = prefixedPath.substring(0, prefixedPath.length - path.length);
    const shortenedPath = path.substring(0, 10);
    const isDeleted = doc._deleted || doc.deleted || false;
    return { id, rev, revDisplay, prefixedPath, path, isDeleted, shortenedId, shortenedPath };
}

export function getLogLevel(showNotice: boolean) {
    return showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
}

export type MapLike<K, V> = {
    set(key: K, value: V): Map<K, V>;
    clear(): void;
    delete(key: K): boolean;
    get(key: K): V | undefined;
    has(key: K): boolean;
    keys: () => IterableIterator<K>;
    get size(): number;
};

export async function autosaveCache<K, V>(db: KeyValueDatabase, mapKey: string): Promise<MapLike<K, V>> {
    const savedData = (await db.get<Map<K, V>>(mapKey)) ?? new Map<K, V>();
    const _commit = () => {
        try {
            scheduleTask("commit-map-save-" + mapKey, 250, async () => {
                await db.set(mapKey, savedData);
            });
        } catch {
            // NO OP.
        }
    };
    return {
        set(key: K, value: V) {
            const modified = savedData.get(key) !== value;
            const result = savedData.set(key, value);
            if (modified) {
                _commit();
            }
            return result;
        },
        clear(): void {
            savedData.clear();
            _commit();
        },
        delete(key: K): boolean {
            const result = savedData.delete(key);
            if (result) {
                _commit();
            }
            return result;
        },
        get(key: K): V | undefined {
            return savedData.get(key);
        },
        has(key) {
            return savedData.has(key);
        },
        keys() {
            return savedData.keys();
        },
        get size() {
            return savedData.size;
        },
    };
}

export function onlyInNTimes(n: number, proc: (progress: number) => any) {
    let counter = 0;
    return function () {
        if (counter++ % n == 0) {
            proc(counter);
        }
    };
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    workspace,
    Uri,
    Disposable,
    Event,
    EventEmitter,
    window,
    FileSystemError,
    FileStat,
    FileType,
    FileChangeEvent,
    FileSystemProvider,
    FileChangeType,
} from "vscode";
import { debounce, throttle } from "./decorators";
import { Model, ModelChangeEvent, OriginalResourceChangeEvent } from "./model";
import {
    EmptyDisposable,
    eventToPromise,
    filterEvent,
    isDescendant,
    pathEquals,
} from "./util";
import { fromHgUri, toHgUri } from "./uri";

interface CacheRow {
    uri: Uri;
    timestamp: number;
}

const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;

export class HgFileSystemProvider implements FileSystemProvider {
    private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
    readonly onDidChangeFile: Event<FileChangeEvent[]> = this._onDidChangeFile
        .event;

    private changedRepositoryRoots = new Set<string>();
    private cache = new Map<string, CacheRow>();
    private mtime = new Date().getTime();
    private disposables: Disposable[] = [];

    constructor(private model: Model) {
        this.disposables.push(
            model.onDidChangeRepository(this.onDidChangeRepository, this),
            model.onDidChangeOriginalResource(
                this.onDidChangeOriginalResource,
                this
            ),
            workspace.registerFileSystemProvider("hg", this, {
                isReadonly: true,
                isCaseSensitive: true,
            })
        );

        setInterval(() => this.cleanup(), FIVE_MINUTES);
    }

    private onDidChangeRepository({ repository }: ModelChangeEvent): void {
        this.changedRepositoryRoots.add(repository.root);
        this.eventuallyFireChangeEvents();
    }

    private onDidChangeOriginalResource({
        uri,
    }: OriginalResourceChangeEvent): void {
        if (uri.scheme !== "file") {
            return;
        }

        const hgUri = toHgUri(uri, "", true);
        this.mtime = new Date().getTime();
        this._onDidChangeFile.fire([
            { type: FileChangeType.Changed, uri: hgUri },
        ]);
    }

    @debounce(1100)
    private eventuallyFireChangeEvents(): void {
        this.fireChangeEvents();
    }

    @throttle
    private async fireChangeEvents(): Promise<void> {
        if (!window.state.focused) {
            const onDidFocusWindow = filterEvent(
                window.onDidChangeWindowState,
                (e) => e.focused
            );
            await eventToPromise(onDidFocusWindow);
        }

        const events: FileChangeEvent[] = [];

        for (const { uri } of this.cache.values()) {
            const fsPath = uri.fsPath;

            for (const root of this.changedRepositoryRoots) {
                if (isDescendant(root, fsPath)) {
                    events.push({ type: FileChangeType.Changed, uri });
                    break;
                }
            }
        }

        if (events.length > 0) {
            this.mtime = new Date().getTime();
            this._onDidChangeFile.fire(events);
        }

        this.changedRepositoryRoots.clear();
    }

    watch(): Disposable {
        return EmptyDisposable;
    }

    async stat(uri: Uri): Promise<FileStat> {
        await this.model.isInitialized;

        const repository = this.model.getRepository(uri);
        if (!repository) {
            throw FileSystemError.FileNotFound();
        }
        // TODO get file type and size from mercurial
        return { type: FileType.File, size: 0, mtime: this.mtime, ctime: 0 };
    }

    readDirectory(): Thenable<[string, FileType][]> {
        throw new Error("Method not implemented.");
    }

    createDirectory(): void {
        throw new Error("Method not implemented.");
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
        await this.model.isInitialized;

        const repository = this.model.getRepository(uri);

        if (!repository) {
            throw FileSystemError.FileNotFound();
        }

        const cacheKey = uri.toString();
        const timestamp = new Date().getTime();
        const cacheValue: CacheRow = { uri, timestamp };

        this.cache.set(cacheKey, cacheValue);

        const { path, ref } = fromHgUri(uri);

        try {
            return await repository.showAsStream(ref, path);
        } catch (err) {
            return new Uint8Array(0);
        }
    }

    writeFile(): void {
        throw new Error("Method not implemented.");
    }

    delete(): void {
        throw new Error("Method not implemented.");
    }

    rename(): void {
        throw new Error("Method not implemented.");
    }

    private cleanup(): void {
        const now = new Date().getTime();
        const cache = new Map<string, CacheRow>();

        for (const row of this.cache.values()) {
            const { path } = fromHgUri(row.uri);
            const isOpen = workspace.textDocuments
                .filter((d) => d.uri.scheme === "file")
                .some((d) => pathEquals(d.uri.fsPath, path));

            if (isOpen || now - row.timestamp < THREE_MINUTES) {
                cache.set(row.uri.toString(), row);
            } else {
                // TODO: should fire delete events?
            }
        }

        this.cache = cache;
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}

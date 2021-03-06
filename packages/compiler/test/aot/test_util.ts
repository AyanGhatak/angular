/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AotCompilerHost} from '@angular/compiler';
import {MetadataBundlerHost, MetadataCollector, ModuleMetadata} from '@angular/tsc-wrapped';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type MockData = string | MockDirectory;

export type MockDirectory = {
  [name: string]: MockData | undefined;
};

export function isDirectory(data: MockData | undefined): data is MockDirectory {
  return typeof data !== 'string';
}

const NODE_MODULES = '/node_modules/';
const IS_GENERATED = /\.(ngfactory|ngstyle)$/;
const angularts = /@angular\/(\w|\/|-)+\.tsx?$/;
const rxjs = /\/rxjs\//;
const tsxfile = /\.tsx$/;
export const settings: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES5,
  declaration: true,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  emitDecoratorMetadata: true,
  experimentalDecorators: true,
  removeComments: false,
  noImplicitAny: false,
  skipLibCheck: true,
  lib: ['lib.es2015.d.ts', 'lib.dom.d.ts'],
  types: []
};

export interface EmitterOptions {
  emitMetadata: boolean;
  mockData?: MockData;
}

export class EmittingCompilerHost implements ts.CompilerHost {
  private angularSourcePath: string|undefined;
  private nodeModulesPath: string|undefined;
  private addedFiles = new Map<string, string>();
  private writtenFiles = new Map<string, string>();
  private scriptNames: string[];
  private root = '/';
  private collector = new MetadataCollector();

  constructor(scriptNames: string[], private options: EmitterOptions) {
    const moduleFilename = module.filename.replace(/\\/g, '/');
    const distIndex = moduleFilename.indexOf('/dist/all');
    if (distIndex >= 0) {
      const root = moduleFilename.substr(0, distIndex);
      this.nodeModulesPath = path.join(root, 'node_modules');
      this.angularSourcePath = path.join(root, 'packages');

      // Rewrite references to scripts with '@angular' to its corresponding location in
      // the source tree.
      this.scriptNames = scriptNames.map(f => this.effectiveName(f));

      this.root = root;
    }
  }

  public addScript(fileName: string, content: string) {
    const scriptName = this.effectiveName(fileName);
    this.addedFiles.set(scriptName, content);
    this.scriptNames.push(scriptName);
  }

  public override(fileName: string, content: string) {
    const scriptName = this.effectiveName(fileName);
    this.addedFiles.set(scriptName, content);
  }

  public addWrittenFile(fileName: string, content: string) {
    this.writtenFiles.set(this.effectiveName(fileName), content);
  }

  public getWrittenFiles(): {name: string, content: string}[] {
    return Array.from(this.writtenFiles).map(f => ({name: f[0], content: f[1]}));
  }

  public get scripts(): string[] { return this.scriptNames; }

  public get written(): Map<string, string> { return this.writtenFiles; }

  public effectiveName(fileName: string): string {
    const prefix = '@angular/';
    return fileName.startsWith('@angular/') ?
        path.join(this.angularSourcePath, fileName.substr(prefix.length)) :
        fileName;
  }

  // ts.ModuleResolutionHost
  fileExists(fileName: string): boolean {
    return this.addedFiles.has(fileName) || open(fileName, this.options.mockData) != null ||
        fs.existsSync(fileName);
  }

  readFile(fileName: string): string {
    const result = this.addedFiles.get(fileName) || open(fileName, this.options.mockData);
    if (result) return result;

    let basename = path.basename(fileName);
    if (/^lib.*\.d\.ts$/.test(basename)) {
      let libPath = ts.getDefaultLibFilePath(settings);
      return fs.readFileSync(path.join(path.dirname(libPath), basename), 'utf8');
    }
    return fs.readFileSync(fileName, 'utf8');
  }

  directoryExists(directoryName: string): boolean {
    return directoryExists(directoryName, this.options.mockData) ||
        (fs.existsSync(directoryName) && fs.statSync(directoryName).isDirectory());
  }

  getCurrentDirectory(): string { return this.root; }

  getDirectories(dir: string): string[] {
    const result = open(dir, this.options.mockData);
    if (result && typeof result !== 'string') {
      return Object.keys(result);
    }
    return fs.readdirSync(dir).filter(p => {
      const name = path.join(dir, p);
      const stat = fs.statSync(name);
      return stat && stat.isDirectory();
    });
  }

  // ts.CompilerHost
  getSourceFile(
      fileName: string, languageVersion: ts.ScriptTarget,
      onError?: (message: string) => void): ts.SourceFile {
    const content = this.readFile(fileName);
    if (content) {
      return ts.createSourceFile(fileName, content, languageVersion, /* setParentNodes */ true);
    }
    throw new Error(`File not found '${fileName}'.`);
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string { return 'lib.d.ts'; }

  writeFile: ts.WriteFileCallback =
      (fileName: string, data: string, writeByteOrderMark: boolean,
       onError?: (message: string) => void, sourceFiles?: ts.SourceFile[]) => {
        this.addWrittenFile(fileName, data);
        if (this.options.emitMetadata && sourceFiles && sourceFiles.length && DTS.test(fileName)) {
          const metadataFilePath = fileName.replace(DTS, '.metadata.json');
          const metadata = this.collector.getMetadata(sourceFiles[0]);
          if (metadata) {
            this.addWrittenFile(metadataFilePath, JSON.stringify(metadata));
          }
        }
      }

  getCanonicalFileName(fileName: string): string {
    return fileName;
  }
  useCaseSensitiveFileNames(): boolean { return false; }
  getNewLine(): string { return '\n'; }
}

const MOCK_NODEMODULES_PREFIX = '/node_modules/';

export class MockCompilerHost implements ts.CompilerHost {
  scriptNames: string[];

  private angularSourcePath: string|undefined;
  private nodeModulesPath: string|undefined;
  public overrides = new Map<string, string>();
  public writtenFiles = new Map<string, string>();
  private sourceFiles = new Map<string, ts.SourceFile>();
  private assumeExists = new Set<string>();
  private traces: string[] = [];

  constructor(
      scriptNames: string[], private data: MockData, private angular: Map<string, string>,
      private libraries?: Map<string, string>[]) {
    this.scriptNames = scriptNames.slice(0);
    const moduleFilename = module.filename.replace(/\\/g, '/');
    let angularIndex = moduleFilename.indexOf('@angular');
    let distIndex = moduleFilename.indexOf('/dist/all');
    if (distIndex >= 0) {
      const root = moduleFilename.substr(0, distIndex);
      this.nodeModulesPath = path.join(root, 'node_modules');
      this.angularSourcePath = path.join(root, 'packages');
    }
  }

  // Test API
  override(fileName: string, content: string) {
    if (content) {
      this.overrides.set(fileName, content);
    } else {
      this.overrides.delete(fileName);
    }
    this.sourceFiles.delete(fileName);
  }

  addScript(fileName: string, content: string) {
    this.overrides.set(fileName, content);
    this.scriptNames.push(fileName);
    this.sourceFiles.delete(fileName);
  }

  assumeFileExists(fileName: string) { this.assumeExists.add(fileName); }

  remove(files: string[]) {
    // Remove the files from the list of scripts.
    const fileSet = new Set(files);
    this.scriptNames = this.scriptNames.filter(f => fileSet.has(f));

    // Remove files from written files
    files.forEach(f => this.writtenFiles.delete(f));
  }

  // ts.ModuleResolutionHost
  fileExists(fileName: string): boolean {
    if (this.overrides.has(fileName) || this.writtenFiles.has(fileName) ||
        this.assumeExists.has(fileName)) {
      return true;
    }
    const effectiveName = this.getEffectiveName(fileName);
    if (effectiveName == fileName) {
      let result = open(fileName, this.data) != null;
      if (!result && fileName.startsWith(MOCK_NODEMODULES_PREFIX)) {
        const libraryPath = fileName.substr(MOCK_NODEMODULES_PREFIX.length - 1);
        for (const library of this.libraries !) {
          if (library.has(libraryPath)) {
            return true;
          }
        }
      }
      return result;
    } else {
      if (fileName.match(rxjs)) {
        let result = fs.existsSync(effectiveName);
        return result;
      }
      const result = this.angular.has(effectiveName);
      return result;
    }
  }

  readFile(fileName: string): string { return this.getFileContent(fileName) !; }

  trace(s: string): void { this.traces.push(s); }

  getCurrentDirectory(): string { return '/'; }

  getDirectories(dir: string): string[] {
    const effectiveName = this.getEffectiveName(dir);
    if (effectiveName === dir) {
      const data = find(dir, this.data);
      if (isDirectory(data)) {
        return Object.keys(data).filter(k => isDirectory(data[k]));
      }
    }
    return [];
  }

  // ts.CompilerHost
  getSourceFile(
      fileName: string, languageVersion: ts.ScriptTarget,
      onError?: (message: string) => void): ts.SourceFile {
    let result = this.sourceFiles.get(fileName);
    if (!result) {
      const content = this.getFileContent(fileName);
      if (content) {
        result = ts.createSourceFile(fileName, content, languageVersion);
        this.sourceFiles.set(fileName, result);
      }
    }
    return result !;
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string { return 'lib.d.ts'; }

  writeFile: ts.WriteFileCallback =
      (fileName: string, data: string, writeByteOrderMark: boolean) => {
        this.writtenFiles.set(fileName, data);
        this.sourceFiles.delete(fileName);
      }

  getCanonicalFileName(fileName: string): string {
    return fileName;
  }
  useCaseSensitiveFileNames(): boolean { return false; }
  getNewLine(): string { return '\n'; }

  // Private methods
  private getFileContent(fileName: string): string|undefined {
    if (this.overrides.has(fileName)) {
      return this.overrides.get(fileName);
    }
    if (this.writtenFiles.has(fileName)) {
      return this.writtenFiles.get(fileName);
    }
    let basename = path.basename(fileName);
    if (/^lib.*\.d\.ts$/.test(basename)) {
      let libPath = ts.getDefaultLibFilePath(settings);
      return fs.readFileSync(path.join(path.dirname(libPath), basename), 'utf8');
    } else {
      let effectiveName = this.getEffectiveName(fileName);
      if (effectiveName === fileName) {
        const result = open(fileName, this.data);
        if (!result && fileName.startsWith(MOCK_NODEMODULES_PREFIX)) {
          const libraryPath = fileName.substr(MOCK_NODEMODULES_PREFIX.length - 1);
          for (const library of this.libraries !) {
            if (library.has(libraryPath)) return library.get(libraryPath);
          }
        }
        return result;
      } else {
        if (fileName.match(rxjs)) {
          if (fs.existsSync(fileName)) {
            return fs.readFileSync(fileName, 'utf8');
          }
        }
        return this.angular.get(effectiveName);
      }
    }
  }

  private getEffectiveName(name: string): string {
    const node_modules = 'node_modules';
    const at_angular = '/@angular';
    const rxjs = '/rxjs';
    if (name.startsWith('/' + node_modules)) {
      if (this.angularSourcePath && name.startsWith('/' + node_modules + at_angular)) {
        return path.join(
            this.angularSourcePath, name.substr(node_modules.length + at_angular.length + 1));
      }
      if (this.nodeModulesPath && name.startsWith('/' + node_modules + rxjs)) {
        return path.join(this.nodeModulesPath, name.substr(node_modules.length + 1));
      }
    }
    return name;
  }
}

const EXT = /(\.ts|\.d\.ts|\.js|\.jsx|\.tsx)$/;
const DTS = /\.d\.ts$/;
const GENERATED_FILES = /\.ngfactory\.ts$|\.ngstyle\.ts$/;

export class MockAotCompilerHost implements AotCompilerHost {
  private metadataCollector = new MetadataCollector();
  private metadataVisible: boolean = true;
  private dtsAreSource: boolean = true;

  constructor(private tsHost: MockCompilerHost) {}

  hideMetadata() { this.metadataVisible = false; }

  tsFilesOnly() { this.dtsAreSource = false; }

  // StaticSymbolResolverHost
  getMetadataFor(modulePath: string): {[key: string]: any}[]|null {
    if (!this.tsHost.fileExists(modulePath)) {
      return null;
    }
    if (DTS.test(modulePath)) {
      if (this.metadataVisible) {
        const metadataPath = modulePath.replace(DTS, '.metadata.json');
        if (this.tsHost.fileExists(metadataPath)) {
          let result = JSON.parse(this.tsHost.readFile(metadataPath));
          return Array.isArray(result) ? result : [result];
        }
      }
    } else {
      const sf = this.tsHost.getSourceFile(modulePath, ts.ScriptTarget.Latest);
      const metadata = this.metadataCollector.getMetadata(sf);
      return metadata ? [metadata] : [];
    }
    return null;
  }

  moduleNameToFileName(moduleName: string, containingFile: string): string|null {
    if (!containingFile || !containingFile.length) {
      if (moduleName.indexOf('.') === 0) {
        throw new Error('Resolution of relative paths requires a containing file.');
      }
      // Any containing file gives the same result for absolute imports
      containingFile = path.join('/', 'index.ts');
    }
    moduleName = moduleName.replace(EXT, '');
    const resolved = ts.resolveModuleName(
                           moduleName, containingFile.replace(/\\/g, '/'),
                           {baseDir: '/', genDir: '/'}, this.tsHost)
                         .resolvedModule;
    return resolved ? resolved.resolvedFileName : null;
  }

  // AotSummaryResolverHost
  loadSummary(filePath: string): string|null { return this.tsHost.readFile(filePath); }

  isSourceFile(sourceFilePath: string): boolean {
    return !GENERATED_FILES.test(sourceFilePath) &&
        (this.dtsAreSource || !DTS.test(sourceFilePath));
  }

  getOutputFileName(sourceFilePath: string): string {
    return sourceFilePath.replace(EXT, '') + '.d.ts';
  }

  // AotCompilerHost
  fileNameToModuleName(importedFile: string, containingFile: string): string|null {
    return importedFile.replace(EXT, '');
  }

  loadResource(path: string): Promise<string> {
    if (this.tsHost.fileExists(path)) {
      return Promise.resolve(this.tsHost.readFile(path));
    } else {
      return Promise.reject(new Error(`Resource ${path} not found.`))
    }
  }
}

export class MockMetadataBundlerHost implements MetadataBundlerHost {
  private collector = new MetadataCollector();

  constructor(private host: ts.CompilerHost) {}

  getMetadataFor(moduleName: string): ModuleMetadata {
    const source = this.host.getSourceFile(moduleName + '.ts', ts.ScriptTarget.Latest);
    return this.collector.getMetadata(source);
  }
}

function find(fileName: string, data: MockData | undefined): MockData|undefined {
  if (!data) return undefined;
  let names = fileName.split('/');
  if (names.length && !names[0].length) names.shift();
  let current: MockData|undefined = data;
  for (let name of names) {
    if (typeof current === 'string')
      return undefined;
    else
      current = (<MockDirectory>current)[name];
    if (!current) return undefined;
  }
  return current;
}

function open(fileName: string, data: MockData | undefined): string|undefined {
  let result = find(fileName, data);
  if (typeof result === 'string') {
    return result;
  }
  return undefined;
}

function directoryExists(dirname: string, data: MockData | undefined): boolean {
  let result = find(dirname, data);
  return !!result && typeof result !== 'string';
}

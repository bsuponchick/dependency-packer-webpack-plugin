import * as childProcess from 'child_process';
import * as fs from 'fs';
import Module = require('module');
import * as path from 'path';
import semver = require('semver');

import { Tapable } from 'tapable';
import * as Webpack from 'webpack';

const builtinModules = Module.builtinModules || require('./builtin-modules').modules;

const findPackageJSON = dirPath => {
  const files = fs.readdirSync(dirPath);
  if (files.some(file => file === 'package.json')) {
    return require(`${dirPath}/package.json`);
  } else {
    return findPackageJSON(path.resolve(`${dirPath}/..`));
  }
};

const getEntryPoints = (module, entryPoints = new Set([])) => {
  module.reasons.forEach(reason => {
    if (reason.module) {
      getEntryPoints(reason.module, entryPoints);
    } else {
      entryPoints.add(module.rawRequest);
    }
  });

  return entryPoints;
};

interface WebpackModule extends Webpack.Module {
  context: string;
  issuer: WebpackModule;
  rawRequest?: string;
  request: string;
}

export class DependencyPackerPlugin implements Tapable.Plugin {

  cwd: string;
  packageManager: string;
  name: string = 'DependencyPackerPlugin';

  projectName: string;
  entries: string | string[] | Webpack.Entry | Webpack.EntryFunc;
  outputDirectory: string;
  outputFilenameTemplate: string;
  dependencies: { [entryName: string]: { [packageName: string]: string } } = {};

  constructor(options) {
    this.cwd = process.cwd();
    this.packageManager = options.packageManager || 'npm';

    this.onCompilationFinishModules = this.onCompilationFinishModules.bind(this);
    this.onDone = this.onDone.bind(this);
  }

  onCompilationFinishModules(modules) {
    const dependentModules = modules.filter(mod => !mod.rawRequest);

    dependentModules.forEach(mod => {
      const issuer = mod.issuer;
      if (issuer) {
        const { name, dependencies } = findPackageJSON(mod.issuer.context);

        if (!builtinModules.find(builtInModule => builtInModule === mod.request)) {
          const entryPoints = getEntryPoints(mod);

          let moduleName = mod.request;
          while (moduleName && !dependencies[moduleName]) {
            moduleName = moduleName.split('/').slice(0, -1).join('/');
          }

          if (!dependencies[moduleName]) {
            console.warn(`[${this.name}] » ${mod.request} was requested, but is not listed in dependencies! Skipping...`);
            return;
          }

          entryPoints.forEach(entryPoint => {
            this.dependencies[entryPoint] = this.dependencies[entryPoint] || {};
            this.dependencies[entryPoint][moduleName] = dependencies[moduleName];
          });
        }
      }
    });
  }

  async onDone(stats) {
    const packaged = Object.keys(this.entries).map(async entryName => {
      const [,entryOutput] = this.outputFilenameTemplate
        .replace(/\[name\]/g, entryName)
        .match(/^(.+)\/.*$/);

      const entryBundleDirectory = `${this.outputDirectory}/${entryOutput}`;

      let dependencies = this.dependencies[this.entries[entryName]] || {};
      const peerDependenciesInstallations = Object.keys(dependencies).map(async pkg => {
        const [,version] = dependencies[pkg].match(/^(?:\^|~)?(.+)/);

        if (semver.valid(version)) {
          const result = await new Promise<string>((resolve, reject) => {
            childProcess.exec(`${this.packageManager} info ${pkg}@${version} peerDependencies --json`, {
              cwd: path.resolve(entryBundleDirectory)
            }, (error, stdout) => {
              if (error) {
                reject(error);
              }

              resolve(stdout);
            });
          });

          let peerDependencies;
          try {
            let type;
            ({ type, ...peerDependencies } = JSON.parse(result));
          } catch (error) {
            peerDependencies = {};
          }

          dependencies = { ...dependencies, ...peerDependencies };
        }
      });

      await Promise.all(peerDependenciesInstallations);

      const entryPackage = {
        name: `${this.projectName}-${entryName}`,
        dependencies,
      };

      new Promise((resolve, reject) => {
        fs.writeFile(
          `${entryBundleDirectory}/package.json`, JSON.stringify(entryPackage, null, 2),
          (error) => {
            if (error) {
              reject(error);
            }

            resolve();
          });
      })

      console.info(`[${this.name}] ` +
                   `» Installing packages for ${entryName}...`);
      return new Promise((resolve, reject) => {
        childProcess.exec(
          `${this.packageManager} install`, {
            cwd: path.resolve(entryBundleDirectory),
          },
          (error) => {
            if (error) {
              reject(error);
            }

            resolve();
          });
      });
    });

    await Promise.all(packaged);

    console.info(`[${this.name}] ` +
                 `» Finished installing packages for all entry points.`);
  }

  apply(compiler: Webpack.Compiler) {
    if (Array.isArray(compiler.options.entry) &&
        compiler.options.entry.length &&
        compiler.options.entry[0] === 'string') {
      console.info(`[${this.name}] ` +
                   `» The behavior of an entry as a string array has not yet been defined.`);
      return;
    } else if (typeof compiler.options.entry === 'string') {
      this.entries = { output: compiler.options.entry };
    } else {
      this.entries = compiler.options.entry;
    }

    this.outputFilenameTemplate = compiler.options.output.filename;
    this.outputDirectory = compiler.options.output.path;

    // Return silently if outputFileSystem is anything other than the default
    // NodeOutputFileSystem.
    if (compiler.outputFileSystem.constructor.name !== 'NodeOutputFileSystem') {
      console.info(`[${this.name}] ` +
                   `» Dependency packing only works for NodeOutputFileSystem.`);
      return;
    }

    ({ name: this.projectName } = require(`${this.cwd}/package.json`));

    if (Object.keys(this.entries).length > 1 &&
        !compiler.options.output.filename.includes('/')) {
      console.warn(`[${this.name}] ` +
                   `» Multiple entry points must be written to ` +
                   `separate directories to avoid conflicts, ` +
                   `e.g.: "config.output.filename: '[name]/[name].js'"`);
      return;
    }

    compiler.hooks.compilation.tap(this.name, (compilation) => {
      compilation.hooks.finishModules.tap(
        this.name, this.onCompilationFinishModules);
    });

    compiler.hooks.done.tapPromise(this.name, this.onDone);
  }
}

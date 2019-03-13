// @flow

import type {
  ParcelConfig,
  FilePath,
  Glob,
  Transformer,
  Resolver,
  Bundler,
  Namer,
  Runtime,
  EnvironmentContext,
  PackageName,
  Packager,
  Optimizer
} from '@parcel/types';
import localRequire from '@parcel/utils/src/localRequire';
import {isMatch} from 'micromatch';
import {basename} from 'path';
import {CONFIG} from '@parcel/plugin';
import logger from '@parcel/logger';
import semver from 'semver';

type Pipeline = Array<PackageName>;
type GlobMap<T> = {[Glob]: T};

const PARCEL_VERSION = require('../package.json').version;

export default class Config {
  configPath: FilePath;
  resolvers: Pipeline;
  transforms: GlobMap<Pipeline>;
  bundler: PackageName;
  namers: Pipeline;
  runtimes: {[EnvironmentContext]: Pipeline};
  packagers: GlobMap<PackageName>;
  optimizers: GlobMap<Pipeline>;
  reporters: Pipeline;
  pluginCache: Map<PackageName, any>;

  constructor(config: ParcelConfig, filePath: FilePath) {
    this.configPath = filePath;
    this.resolvers = config.resolvers || [];
    this.transforms = config.transforms || {};
    this.runtimes = config.runtimes || {};
    this.bundler = config.bundler || '';
    this.namers = config.namers || [];
    this.packagers = config.packagers || {};
    this.optimizers = config.optimizers || {};
    this.reporters = config.reporters || [];
    this.pluginCache = new Map();
  }

  async loadPlugin(pluginName: PackageName) {
    let cached = this.pluginCache.get(pluginName);
    if (cached) {
      return cached;
    }

    let [resolved, pkg] = await localRequire.resolve(
      pluginName,
      this.configPath
    );

    // Validate the engines.parcel field in the plugin's package.json
    let parcelVersionRange = pkg.engines && pkg.engines.parcel;
    if (!parcelVersionRange) {
      logger.warn(
        `The plugin "${pluginName}" needs to specify a \`package.json#engines.parcel\` field with the supported Parcel version range.`
      );
    }

    if (
      parcelVersionRange &&
      !semver.satisfies(PARCEL_VERSION, parcelVersionRange)
    ) {
      throw new Error(
        `The plugin "${pluginName}" is not compatible with the current version of Parcel. Requires "${parcelVersionRange}" but the current version is "${PARCEL_VERSION}".`
      );
    }

    // $FlowFixMe
    let plugin = require(resolved);
    plugin = plugin.default ? plugin.default : plugin;
    plugin = plugin[CONFIG];
    this.pluginCache.set(pluginName, plugin);
    return plugin;
  }

  async loadPlugins(plugins: Pipeline) {
    return Promise.all(plugins.map(pluginName => this.loadPlugin(pluginName)));
  }

  async getResolvers(): Promise<Array<Resolver>> {
    if (this.resolvers.length === 0) {
      throw new Error('No resolver plugins specified in .parcelrc config');
    }

    return this.loadPlugins(this.resolvers);
  }

  async getTransformers(filePath: FilePath): Promise<Array<Transformer>> {
    let transformers: Pipeline | null = this.matchGlobMapPipelines(
      filePath,
      this.transforms
    );
    if (!transformers || transformers.length === 0) {
      throw new Error(`No transformers found for "${filePath}".`);
    }

    return this.loadPlugins(transformers);
  }

  async getBundler(): Promise<Bundler> {
    if (!this.bundler) {
      throw new Error('No bundler specified in .parcelrc config');
    }

    return this.loadPlugin(this.bundler);
  }

  async getNamers(): Promise<Array<Namer>> {
    if (this.namers.length === 0) {
      throw new Error('No namer plugins specified in .parcelrc config');
    }

    return this.loadPlugins(this.namers);
  }

  async getRuntimes(context: EnvironmentContext): Promise<Array<Runtime>> {
    let runtimes = this.runtimes[context];
    if (!runtimes) {
      return [];
    }

    return this.loadPlugins(runtimes);
  }

  async getPackager(filePath: FilePath): Promise<Packager> {
    let packagerName: ?PackageName = this.matchGlobMap(
      filePath,
      this.packagers
    );
    if (!packagerName) {
      throw new Error(`No packager found for "${filePath}".`);
    }

    return this.loadPlugin(packagerName);
  }

  async getOptimizers(filePath: FilePath): Promise<Array<Optimizer>> {
    let optimizers: ?Pipeline = this.matchGlobMapPipelines(
      filePath,
      this.optimizers
    );
    if (!optimizers) {
      return [];
    }

    return this.loadPlugins(optimizers);
  }

  isGlobMatch(filePath: FilePath, pattern: Glob) {
    return isMatch(filePath, pattern) || isMatch(basename(filePath), pattern);
  }

  matchGlobMap(filePath: FilePath, globMap: {[Glob]: any}) {
    for (let pattern in globMap) {
      if (this.isGlobMatch(filePath, pattern)) {
        return globMap[pattern];
      }
    }

    return null;
  }

  matchGlobMapPipelines(filePath: FilePath, globMap: {[Glob]: Pipeline}) {
    let matches = [];
    for (let pattern in globMap) {
      if (this.isGlobMatch(filePath, pattern)) {
        matches.push(globMap[pattern]);
      }
    }

    let flatten = () => {
      let pipeline = matches.shift() || [];
      let spreadIndex = pipeline.indexOf('...');
      if (spreadIndex >= 0) {
        pipeline = [
          ...pipeline.slice(0, spreadIndex),
          ...flatten(),
          ...pipeline.slice(spreadIndex + 1)
        ];
      }

      if (pipeline.includes('...')) {
        throw new Error(
          'Only one spread parameter can be included in a config pipeline'
        );
      }

      return pipeline;
    };

    let res = flatten();
    return res;
  }

  static deserialize({
    configPath,
    ...config
  }: ParcelConfig & {|configPath: string|}) {
    return new Config(config, configPath);
  }
}

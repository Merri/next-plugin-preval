import fs from 'fs';
import type webpack from 'webpack';
import requireFromString from 'require-from-string';
// @ts-ignore
import { resolvePath as defaultResolvePath } from 'babel-plugin-module-resolver';
import { transform } from '@babel/core';
import { addHook } from 'pirates';
import { getOptions } from 'loader-utils';
import { createMatchPath, loadConfig } from 'tsconfig-paths';
import isSerializable from './is-serializable';

class PrevalError extends Error {}

interface PrevalLoaderOptions {
  extensions?: string[];
}

const defaultExtensions = ['.js', '.jsx', '.ts', '.tsx'];

const readJson = (filename: string) => {
  try {
    return require(filename);
  } catch {
    return undefined;
  }
};

const fileExists = (filename: string) => {
  try {
    return fs.existsSync(filename);
  } catch {
    return false;
  }
};

export async function _prevalLoader(
  content: string,
  resource: string,
  options: PrevalLoaderOptions
) {
  const { extensions = defaultExtensions } = options;

  const configLoaderResult = loadConfig();

  const configLoaderSuccessResult =
    configLoaderResult.resultType === 'failed' ? null : configLoaderResult;

  const matchPath =
    configLoaderSuccessResult &&
    createMatchPath(
      configLoaderSuccessResult.absoluteBaseUrl,
      configLoaderSuccessResult.paths
    );

  const moduleResolver =
    configLoaderSuccessResult &&
    ([
      'module-resolver',
      {
        extensions,
        resolvePath: (sourcePath: string, currentFile: string, opts: any) => {
          if (matchPath) {
            try {
              return matchPath(sourcePath, readJson, fileExists, extensions);
            } catch {
              return defaultResolvePath(sourcePath, currentFile, opts);
            }
          }

          return defaultResolvePath(sourcePath, currentFile, opts);
        },
      },
    ] as const);

  const hook = (code: string, filename?: string) => {
    const result = transform(
      `require('regenerator-runtime/runtime');\n${code}`,
      {
        filename: filename || 'preval-file.ts',
        presets: [['@babel/preset-env', { targets: 'node 10' }], 'next/babel'],
        plugins: [
          // conditionally add
          ...(moduleResolver ? [moduleResolver] : []),
        ],
      }
    );

    if (!result?.code) {
      throw new PrevalError(
        `Could not get babel file result ${filename ? `for ${filename}` : ''} `
      );
    }

    return result.code;
  };

  const revert = addHook(hook, { exts: extensions });

  const data = await (async () => {
    try {
      const mod = requireFromString(hook(content), `${resource}.preval-run.js`);

      if (!mod.default) {
        throw new PrevalError(
          'No default export. Did you forget to `export default`?'
        );
      }

      return await mod.default;
    } catch (e) {
      throw new PrevalError(`Failed to pre-evaluate "${resource}". ${e}`);
    } finally {
      revert();
    }
  })();

  isSerializable(resource, data);

  // NOTE we wrap in JSON.parse because that's faster for JS engines to parse
  // over javascript. see here https://v8.dev/blog/cost-of-javascript-2019#json
  //
  // We wrap in JSON.stringify twice. Once for a JSON string and once again for
  // a JSON string that can be embeddable in javascript.
  return `module.exports = JSON.parse(${JSON.stringify(JSON.stringify(data))})`;
}

const loader: webpack.loader.Loader = function (content) {
  const callback = this.async();

  this.cacheable(false);

  if (!callback) {
    throw new PrevalError('Async was not supported.');
  }

  _prevalLoader(content.toString(), this.resource, getOptions(this))
    .then((result) => {
      callback(null, result);
    })
    .catch((e) => {
      callback(e);
    });
};

export default loader;

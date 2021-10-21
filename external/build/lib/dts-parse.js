/*
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const typedoc = require('typedoc');

// nb. we include "Event" as typedoc flattens "event.Events" sometimes (?)
const chromeEventRefTypes = ['CustomChromeEvent', 'events.Event', 'Event'];

class Transform {
  /**
   * @param {typedoc.JSONOutput.ProjectReflection} project
   */
  constructor(project) {
    this.project = project;

    /** @type {{[id: string]: typedoc.JSONOutput.DeclarationReflection}} */
    this.namespaces = {};
  }

  /**
   */
  async run() {
    // Find all namespaces with non-namespace children.
    this.walk(this.project);
    return this.namespaces;
  }

  /**
   * @param {typedoc.JSONOutput.DeclarationReflection} node
   * @param {typedoc.JSONOutput.DeclarationReflection[]} parents
   */
  walk(node, parents = []) {
    this.visit(node, parents);

    if (node.children) {
      const children = node.children.filter(this.filter);
      for (const c of children) {
        this.walk(c, [...parents, node]);
      }
      node.children = children;
    }
  }

  /**
   * @param {typedoc.JSONOutput.DeclarationReflection} node
   * @param {typedoc.JSONOutput.DeclarationReflection[]} parents
   */
  visit(node, parents) {
    const parts = parents
      .filter(parent => parent.kindString !== 'Project')
      .map(parent => parent.name);
    parts.push(node.name);
    const fqdn = parts.filter(x => x).join('.');

    if (node.kindString === 'Namespace') {
      const hasNonNamespaceChild = (node.children ?? []).some(
        x => x.kindString !== 'Namespace'
      );
      if (!hasNonNamespaceChild) {
        return;
      }
      this.namespaces[fqdn] = node;
    }

    const extendedNode = /** @type {ExtendedDeclarationReflection} */ (node);

    extendedNode._name = fqdn;
    extendedNode._feature = this._processTags(node?.comment?.tags ?? []);

    // This is an event reference (used in Chrome extensions), so parse it for easy reference.
    if (
      node.type?.type === 'reference' &&
      chromeEventRefTypes.includes(node.type.name)
    ) {
      const firstArgument = node.type.typeArguments?.[0];
      if (!firstArgument) {
        throw new Error(`got reference to ${node.type.name} without argument`);
      }

      /** @type {typedoc.JSONOutput.ParameterReflection[]|undefined} */
      let parameters;

      if (node.type.name === 'CustomChromeEvent') {
        // CustomChromeEvent specifies all parameters to addListener directly.
        const arg = /** @type {typedoc.JSONOutput.ReflectionType} */ (
          firstArgument
        );
        parameters = arg.declaration?.signatures?.[0]?.parameters;
      } else if (firstArgument.type === 'intrinsic') {
        // This is a declarative event, because its first argument is "never".
        const intrinsicType = /** @type {typedoc.JSONOutput.IntrinsicType} */ (
          firstArgument
        );
        if (intrinsicType.name !== 'never') {
          throw new Error(
            `unexpected first argument for declarative event: ${JSON.stringify(
              firstArgument
            )}`
          );
        }

        // TODO: something
      } else {
        // Otherwise, steal the declaration and include it as a single paramater.
        parameters = [
          {
            id: -1,
            name: 'callback',
            kind: 32768,
            flags: {},
            type: node.type.typeArguments?.[0],
          },
        ];
      }

      /** @type {ExtendedDeclarationReflection["_event"]} */
      const extendedEvent = {};
      if (parameters) {
        extendedEvent.addListenerParameters = parameters;
      }
      extendedNode._event = extendedEvent;
    }
  }

  /**
   * @param {typedoc.JSONOutput.CommentTag[]} tags
   * @return {FeatureInfo}
   */
  _processTags(tags) {
    /** @type {{value: string, since?: string}} */
    const deprecated = {value: ''};

    /** @type {FeatureInfo} */
    const out = {
      channel: 'stable',
    };

    tags.forEach(({tag, text}) => {
      text = text.trim(); // some show up with extra \n

      switch (tag) {
        case 'chrome-platform-apps':
          out.platformAppsOnly = true;
          break;
        case 'since':
          out.since = text;
          break;
        case 'chrome-channel':
          out.channel = text;
          break;
        case 'chrome-permission':
          out.permissions = out.permissions ?? [];
          out.permissions.push(text);
          break;
        case 'chrome-manifest':
          out.manifestKeys = out.manifestKeys ?? [];
          out.manifestKeys.push(text);
          break;
        case 'deprecated':
          out.deprecated = deprecated;
          deprecated.value = text;
          break;
        case 'chrome-deprecated-since':
          out.deprecated = deprecated;
          deprecated.since = text;
          break;
        case 'chrome-min-manifest':
          out.minManifest = text;
          break;
        case 'chrome-max-manifest':
          out.maxManifest = text;
          break;
        case 'chrome-disallow-service-workers':
          out.disallowServiceWorkers = true;
          break;
      }
    });

    return out;
  }

  /**
   * @param {typedoc.JSONOutput.DeclarationReflection} node
   * @return {boolean}
   */
  filter(node) {
    // nb. All of our parsed namespaces are external.
    return !(node.flags?.isPrivate || node.name.startsWith('_'));
  }
}

/**
 * Fetches and builds typedoc JSON for the given .d.ts source files.
 *
 * @param {...string} sources
 * @return {Promise<{[id: string]: typedoc.JSONOutput.DeclarationReflection}>}
 */
module.exports = async function parse(...sources) {
  const app = new typedoc.Application();
  app.options.addReader(new typedoc.TSConfigReader());
  app.bootstrap({
    // excludeExternals: true,
    excludeInternal: true,
    excludePrivate: true,
    excludeProtected: true,
    entryPoints: sources,
    logger(message, level) {
      switch (level) {
        case typedoc.LogLevel.Warn:
        case typedoc.LogLevel.Error:
          throw new Error(`failed to parse typedoc: ${message}`);
      }
    },
  });
  app.options.setCompilerOptions(
    sources,
    {
      // TODO: for Workbox assume we're a webworker
      // lib: ['lib.webworker.d.ts'],
      declaration: true,
    },
    undefined
  );
  const reflection = app.convert();
  if (!reflection) {
    throw new Error(`failed to convert modules: ${sources}`);
  }
  const json = app.serializer.projectToObject(reflection);
  const t = new Transform(json);

  const out = await t.run();
  return out;
};

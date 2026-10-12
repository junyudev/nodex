import {
  AnyExtension as AnyTiptapExtension,
  Extension as TiptapExtension,
} from "@tiptap/core";
import { keymap } from "@tiptap/pm/keymap";
import { Plugin } from "prosemirror-state";
import { updateBlockTr } from "../../../api/blockManipulation/commands/updateBlock/updateBlock.js";
import { setTextCursorPosition } from "../../../api/blockManipulation/selections/textCursorPosition.js";
import {
  getBlockInfoFromSelection,
  getNodeId,
} from "../../../api/getBlockInfoFromPos.js";
import {
  createAutomaticInputRulesPlugin,
  type AutomaticInputRule,
} from "../../../extensions/AutomaticInputRules/AutomaticInputRules.js";
import { createDefaultInlineInputRules } from "../../../extensions/AutomaticInputRules/defaultInlineInputRules.js";
import { sortByDependencies } from "../../../util/topo-sort.js";
import type {
  BlockNoteEditor,
  BlockNoteEditorOptions,
} from "../../BlockNoteEditor.js";
import type {
  Extension,
  ExtensionFactoryInstance,
  ExtensionFactory,
} from "../../BlockNoteExtension.js";
import { originalFactorySymbol } from "./symbol.js";
import {
  getDefaultExtensions,
  getDefaultTiptapExtensions,
} from "./extensions.js";

export class ExtensionManager {
  /**
   * A set of extension keys which are disabled by the options
   */
  private disabledExtensions = new Set<string>();
  /**
   * A list of all the extensions that are registered to the editor
   */
  private extensions: Extension[] = [];
  /**
   * A map of all the abort controllers for each extension that has an init method defined
   */
  private abortMap = new Map<Extension, AbortController>();
  /**
   * A map of all the extension factories that are registered to the editor
   */
  private extensionFactories = new Map<ExtensionFactory, Extension>();
  /**
   * Because a single blocknote extension can both have it's own prosemirror plugins & additional generated ones (e.g. keymap & input rules plugins)
   * We need to keep track of all the plugins for each extension, so that we can remove them when the extension is unregistered
   */
  private extensionPlugins: Map<Extension, Plugin[]> = new Map();
  /**
   * Maps an extension key to the set of extension keys that declared it as a
   * dependency via `blockNoteExtensions`. A sub-extension is a dependency of
   * the extension that declares it, so it must run *before* its parent(s).
   */
  private blockNoteExtensionDependents: Map<string, Set<string>> = new Map();

  /** Extension cleanup is registration-scoped and must be idempotent. */
  private destroyedExtensions = new WeakSet<Extension>();

  constructor(
    private editor: BlockNoteEditor<any, any, any>,
    private options: BlockNoteEditorOptions<any, any, any>,
  ) {
    /**
     * When the editor is first mounted, we need to initialize all the extensions
     */
    editor.onMount(() => {
      const view = editor.prosemirrorView;
      if (!view) {
        throw new Error("Mounted BlockNote editor has no ProseMirror view");
      }
      for (const extension of this.extensions) {
        // If the extension has an init function, we can initialize it, otherwise, it is already added to the editor
        if (extension.mount) {
          // We create an abort controller for each extension, so that we can abort the extension when the editor is unmounted
          const abortController = new window.AbortController();
          const unmountCallback = extension.mount({
            view,
            dom: view.dom,
            root: view.root,
            signal: abortController.signal,
          });
          // If the extension returns a method to unmount it, we can register it to be called when the abort controller is aborted
          if (unmountCallback) {
            abortController.signal.addEventListener("abort", () => {
              unmountCallback();
            });
          }
          // Keep track of the abort controller for each extension, so that we can abort it when the editor is unmounted
          this.abortMap.set(extension, abortController);
        }
      }
    });

    /**
     * When the editor is unmounted, we need to abort all the extensions' abort controllers
     */
    editor.onUnmount(() => {
      for (const [extension, abortController] of this.abortMap.entries()) {
        // No longer track the abort controller for this extension
        this.abortMap.delete(extension);
        // Abort each extension's abort controller
        abortController.abort();
      }
    });

    // TODO do disabled extensions need to be only for editor base extensions? Or all of them?
    this.disabledExtensions = new Set(options.disableExtensions || []);

    // Add the default extensions
    for (const extension of getDefaultExtensions(this.editor, this.options)) {
      this.addExtension(extension);
    }

    // Add the extensions from the options
    for (const extension of this.options.extensions ?? []) {
      this.addExtension(extension);
    }

    // Add the extensions from blocks specs
    for (const block of Object.values(this.editor.schema.blockSpecs)) {
      for (const extension of block.extensions ?? []) {
        this.addExtension(extension);
      }
    }

    // Inline content owns editor behavior too (for example, source-aware
    // keyboard commands and typing transforms), so register its declared
    // extensions through the same lifecycle and dependency graph as Blocks.
    for (const inlineContent of Object.values(
      this.editor.schema.inlineContentSpecs,
    )) {
      if (!("extensions" in inlineContent)) continue;
      for (const extension of inlineContent.extensions ?? []) {
        this.addExtension(extension);
      }
    }
  }

  /**
   * Register one or more extensions to the editor after the editor is initialized.
   *
   * This allows users to switch on & off extensions "at runtime".
   */
  public registerExtension(
    extension:
      | Extension
      | ExtensionFactoryInstance
      | (Extension | ExtensionFactoryInstance)[],
  ): void {
    this.replaceExtension(undefined, extension);
  }

  /**
   * Register an extension to the editor
   * @param extension - The extension to register
   * @returns The extension instance
   */
  private addExtension(
    extension: Extension | ExtensionFactoryInstance,
    /**
     * When this extension is being added as a dependency declared in another
     * extension's `blockNoteExtensions`, this is the key of that declaring
     * (parent) extension.
     */
    parentKey?: string,
  ): Extension | undefined {
    let instance: Extension;
    if (typeof extension === "function") {
      instance = extension({ editor: this.editor });
    } else {
      instance = extension;
    }

    if (!instance) {
      return undefined as any;
    }
    if (this.disabledExtensions.has(instance.key)) {
      this.destroyExtension(instance);
      return undefined as any;
    }

    // A sub-extension declared via `blockNoteExtensions` must run before the
    // extension that declares it. We record this dependency before the
    // de-duplication check below, so that it applies even when multiple
    // extensions declare the same sub-extension (and all but the first are
    // de-duplicated).
    if (parentKey) {
      let dependents = this.blockNoteExtensionDependents.get(instance.key);
      if (!dependents) {
        dependents = new Set();
        this.blockNoteExtensionDependents.set(instance.key, dependents);
      }
      dependents.add(parentKey);
    }

    // De-duplicate by key: if an extension with the same key is already
    // registered, don't register it again. This allows an extension to declare
    // a dependency on another extension via `blockNoteExtensions` without
    // conflicting when the user (or another extension) registers that same
    // extension directly. The first registration wins.
    if (this.extensions.some((e) => e.key === instance.key)) {
      return undefined as any;
    }

    // Now that we know that the extension is not disabled, we can add it to the extension factories
    if (typeof extension === "function") {
      const originalFactory = (instance as any)[originalFactorySymbol] as (
        ...args: any[]
      ) => ExtensionFactoryInstance;

      if (typeof originalFactory === "function") {
        this.extensionFactories.set(originalFactory, instance);
      }
    }

    this.extensions.push(instance);

    if (instance.blockNoteExtensions) {
      for (const subExtension of instance.blockNoteExtensions) {
        this.addExtension(subExtension, instance.key);
      }
    }

    return instance as any;
  }

  /**
   * Resolve an extension or a list of extensions into a list of extension instances
   * @param toResolve - The extension or list of extensions to resolve
   * @returns A list of extension instances
   */
  private resolveExtensions(
    toResolve:
      | undefined
      | string
      | Extension
      | ExtensionFactory
      | (Extension | ExtensionFactory | string | undefined)[],
  ): Extension[] {
    const extensions = [] as Extension[];
    if (typeof toResolve === "function") {
      const instance = this.extensionFactories.get(toResolve);
      if (instance) {
        extensions.push(instance);
      }
    } else if (Array.isArray(toResolve)) {
      for (const extension of toResolve) {
        extensions.push(...this.resolveExtensions(extension));
      }
    } else if (typeof toResolve === "object" && "key" in toResolve) {
      extensions.push(toResolve);
    } else if (typeof toResolve === "string") {
      const instance = this.extensions.find((e) => e.key === toResolve);
      if (instance) {
        extensions.push(instance);
      }
    }
    return extensions;
  }

  /**
   * Unregister an extension from the editor
   * @param toUnregister - The extension to unregister
   * @returns void
   */
  public unregisterExtension(
    toUnregister:
      | undefined
      | string
      | Extension
      | ExtensionFactory
      | (Extension | ExtensionFactory | string | undefined)[],
  ): void {
    this.replaceExtension(toUnregister, []);
  }

  /**
   * Atomically replace extension instances in the editor.
   * @param toUnregister - The extensions to unregister, can be a string key, an extension instance, an extension factory, or an array of any of those
   * @param toRegister - The extensions to register, can be an extension instance, an extension factory, or an array of any of those
   * @returns void
   */
  public replaceExtension(
    toUnregister:
      | undefined
      | string
      | Extension
      | ExtensionFactory
      | (Extension | ExtensionFactory | string | undefined)[],
    toRegister:
      | Extension
      | ExtensionFactoryInstance
      | (Extension | ExtensionFactoryInstance)[],
  ): void {
    // ---- Remove phase (no updatePlugins call) ----
    const extensionsToRemove = this.resolveExtensions(toUnregister);

    if (toUnregister && !extensionsToRemove.length) {
      // eslint-disable-next-line no-console
      console.warn(`No extensions found to unregister`, toUnregister);
    }

    let didWarnUnregister = false;
    // We collect both plugin references and plugin keys to remove.
    // Key-based matching is needed because re-entrant dispatches (e.g. from
    // y-prosemirror view hooks) can replace plugin instances in the ProseMirror
    // state with new objects that share the same key, making reference-based
    // matching unreliable.
    const pluginRefsToRemove = new Set<Plugin>();
    const pluginKeysToRemove = new Set<string>();
    for (const extension of extensionsToRemove) {
      this.extensions = this.extensions.filter((e) => e !== extension);
      this.extensionFactories.forEach((instance, factory) => {
        if (instance === extension) {
          this.extensionFactories.delete(factory);
        }
      });
      this.abortMap.get(extension)?.abort();
      this.abortMap.delete(extension);
      this.destroyExtension(extension);

      const plugins = this.extensionPlugins.get(extension);
      plugins?.forEach((plugin) => {
        pluginRefsToRemove.add(plugin);
        const key = (plugin as any).spec?.key;
        const keyStr = typeof key === "object" && key ? key.key : key;
        if (typeof keyStr === "string") {
          pluginKeysToRemove.add(keyStr);
        }
      });
      this.extensionPlugins.delete(extension);

      if (extension.tiptapExtensions && !didWarnUnregister) {
        didWarnUnregister = true;
        // eslint-disable-next-line no-console
        console.warn(
          `Extension ${extension.key} has tiptap extensions, but they will not be removed. Please separate the extension into multiple extensions if you want to remove them, or re-initialize the editor.`,
          toUnregister,
        );
      }
    }

    // ---- Add phase (no updatePlugins call) ----
    const newExtensions = ([] as (Extension | ExtensionFactoryInstance)[])
      .concat(toRegister)
      .filter(Boolean) as (Extension | ExtensionFactoryInstance)[];

    const registeredExtensions = newExtensions
      .map((ext) => this.addExtension(ext))
      .filter(Boolean) as Extension[];

    const pluginsToAdd: Plugin[] = [];
    for (const extension of registeredExtensions) {
      if (extension?.tiptapExtensions) {
        // eslint-disable-next-line no-console
        console.warn(
          `Extension ${extension.key} has tiptap extensions, but these cannot be changed after initializing the editor. Please separate the extension into multiple extensions if you want to add them, or re-initialize the editor.`,
          extension,
        );
      }

      if (extension?.inputRules?.length) {
        // eslint-disable-next-line no-console
        console.warn(
          `Extension ${extension.key} has input rules, but these cannot be changed after initializing the editor. Please separate the extension into multiple extensions if you want to add them, or re-initialize the editor.`,
          extension,
        );
      }

      this.getProsemirrorPluginsFromExtension(extension).plugins.forEach(
        (plugin) => {
          pluginsToAdd.push(plugin);
        },
      );
    }

    // Nothing to do
    if (
      !pluginRefsToRemove.size &&
      !pluginKeysToRemove.size &&
      !pluginsToAdd.length
    ) {
      return;
    }

    // ---- Single atomic plugin update ----
    this.updatePlugins((plugins) => [
      ...plugins.filter((plugin) => {
        // Fast path: exact reference match
        if (pluginRefsToRemove.has(plugin)) {
          return false;
        }
        // Fallback: match by key string (handles cases where plugin instances
        // in the state differ from the ones we tracked)
        if (pluginKeysToRemove.size) {
          const key = (plugin as any).spec?.key;
          const keyStr = typeof key === "object" && key ? key.key : key;
          if (typeof keyStr === "string" && pluginKeysToRemove.has(keyStr)) {
            return false;
          }
        }
        return true;
      }),
      ...pluginsToAdd,
    ]);
  }

  /**
   * Allows resetting the current prosemirror state's plugins
   * @param update - A function that takes the current plugins and returns the new plugins
   * @returns void
   */
  private updatePlugins(update: (plugins: Plugin[]) => Plugin[]): void {
    const currentState = this.editor.prosemirrorState;

    const state = currentState.reconfigure({
      plugins: update(currentState.plugins.slice()),
    });

    // Tiptap's state proxy deliberately supports updateState while headless.
    // Dynamic extension registration belongs to the editor model lifetime and
    // must not require a mounted DOM view.
    this.editor._tiptapEditor.view.updateState(state);
  }

  /**
   * Get all the extensions that are registered to the editor
   */
  public getTiptapExtensions(): AnyTiptapExtension[] {
    // Start with the default tiptap extensions
    const tiptapExtensions = getDefaultTiptapExtensions(
      this.editor,
      this.options,
    ).filter((extension) => !this.disabledExtensions.has(extension.name));

    const getPriority = sortByDependencies(
      this.extensions.map((extension) => {
        // A sub-extension declared via `blockNoteExtensions` must run before the
        // extension(s) that declared it, so we merge those parents into its
        // `runsBefore`.
        const dependents = this.blockNoteExtensionDependents.get(extension.key);
        if (!dependents?.size) {
          return extension;
        }
        return {
          key: extension.key,
          runsBefore: [...(extension.runsBefore ?? []), ...dependents],
        };
      }),
    );

    const inputRulesByPriority = new Map<number, AutomaticInputRule[]>();
    for (const extension of this.extensions) {
      if (extension.tiptapExtensions) {
        tiptapExtensions.push(...extension.tiptapExtensions);
      }

      const priority = getPriority(extension.key);

      const { plugins: prosemirrorPlugins, inputRules } =
        this.getProsemirrorPluginsFromExtension(extension);
      // Sometimes a blocknote extension might need to make additional prosemirror plugins, so we generate them here
      if (prosemirrorPlugins.length) {
        tiptapExtensions.push(
          TiptapExtension.create({
            name: extension.key,
            priority,
            addProseMirrorPlugins: () => prosemirrorPlugins,
          }),
        );
      }
      if (inputRules.length) {
        if (!inputRulesByPriority.has(priority)) {
          inputRulesByPriority.set(priority, []);
        }
        inputRulesByPriority.get(priority)!.push(...inputRules);
      }
    }

    // Collect every typing rule into one engine so raw input, automatic
    // transforms, history boundaries, and immediate Backspace share one model.
    tiptapExtensions.push(
      TiptapExtension.create({
        name: "blocknote-input-rules",
        addProseMirrorPlugins() {
          const rules = createDefaultInlineInputRules(this.editor.schema);
          Array.from(inputRulesByPriority.keys())
            // We sort the rules by their priority (the key)
            .sort((a, b) => a - b)
            .reverse()
            .forEach((priority) => {
              // Append in reverse priority order
              rules.push(...inputRulesByPriority.get(priority)!);
            });
          return [createAutomaticInputRulesPlugin({ rules })];
        },
      }),
    );

    // Add any tiptap extensions from the `_tiptapOptions`
    for (const extension of this.options._tiptapOptions?.extensions ?? []) {
      tiptapExtensions.push(extension);
    }

    tiptapExtensions.push(
      TiptapExtension.create({
        name: "blockNoteExtensionRegistrationLifecycle",
        onDestroy: () => {
          for (const extension of this.extensions) {
            this.destroyExtension(extension);
          }
        },
      }),
    );

    return tiptapExtensions;
  }

  private destroyExtension(extension: Extension): void {
    if (this.destroyedExtensions.has(extension)) return;
    this.destroyedExtensions.add(extension);
    extension.destroy?.();
  }

  /**
   * This maps a blocknote extension into an array of Prosemirror plugins if it has any of the following:
   * - plugins
   * - keyboard shortcuts
   * - input rules
   */
  private getProsemirrorPluginsFromExtension(extension: Extension): {
    plugins: Plugin[];
    inputRules: AutomaticInputRule[];
  } {
    const plugins: Plugin[] = [...(extension.prosemirrorPlugins ?? [])];
    const inputRules: AutomaticInputRule[] = [];
    if (
      !extension.prosemirrorPlugins?.length &&
      !Object.keys(extension.keyboardShortcuts || {}).length &&
      !extension.inputRules?.length &&
      !extension.automaticInputRules?.length
    ) {
      // We can bail out early if the extension has no features to add to the tiptap editor
      return { plugins, inputRules };
    }

    this.extensionPlugins.set(extension, plugins);

    if (extension.automaticInputRules?.length) {
      inputRules.push(...extension.automaticInputRules);
    }

    if (extension.inputRules?.length) {
      inputRules.push(
        ...extension.inputRules.map((inputRule) => {
          return {
            find: inputRule.find,
            inCodeMark: false,
            transform: ({ state, match, range }) => {
              const replaceWith = inputRule.replace({
                match,
                range,
                editor: this.editor,
              });
              if (replaceWith) {
                const tr = state.tr;
                const blockInfo = getBlockInfoFromSelection(tr);

                if (
                  !blockInfo.isBlockContainer ||
                  this.editor.schema.blockSchema[blockInfo.blockNoteType]
                    ?.content !== "inline"
                ) {
                  return null;
                }

                tr.deleteRange(range.from, range.to);
                updateBlockTr(tr, blockInfo.bnBlock.beforePos, replaceWith);
                // updateBlockTr's replaceWith path leaves the selection after
                // the new block when the content is replaced wholesale (e.g.
                // when the rule returns content: []). Move the cursor back
                // inside the new block so the user can keep typing.
                setTextCursorPosition(
                  tr,
                  getNodeId(blockInfo.bnBlock.node, tr.doc),
                  "start",
                );
                return tr;
              }
              return null;
            },
          } satisfies AutomaticInputRule;
        }),
      );
    }

    if (Object.keys(extension.keyboardShortcuts || {}).length) {
      plugins.push(
        keymap(
          Object.fromEntries(
            Object.entries(extension.keyboardShortcuts!).map(([key, value]) => [
              key,
              () => value({ editor: this.editor }),
            ]),
          ),
        ),
      );
    }

    return { plugins, inputRules };
  }

  /**
   * Get all extensions
   */
  public getExtensions(): Map<string, Extension> {
    return new Map(
      this.extensions.map((extension) => [extension.key, extension]),
    );
  }

  /**
   * Get a specific extension by it's instance
   */
  public getExtension<
    const Ext extends Extension | ExtensionFactory = Extension,
  >(
    extension: string,
  ):
    | (Ext extends Extension
        ? Ext
        : Ext extends ExtensionFactory
          ? ReturnType<ReturnType<Ext>>
          : never)
    | undefined;
  public getExtension<const T extends ExtensionFactory>(
    extension: T,
  ): ReturnType<ReturnType<T>> | undefined;
  public getExtension<const T extends ExtensionFactory | string = string>(
    extension: T,
  ):
    | (T extends ExtensionFactory
        ? ReturnType<ReturnType<T>>
        : T extends string
          ? Extension
          : never)
    | undefined {
    if (typeof extension === "string") {
      const instance = this.extensions.find((e) => e.key === extension);
      if (!instance) {
        return undefined;
      }
      return instance as any;
    } else if (typeof extension === "function") {
      const instance = this.extensionFactories.get(extension);
      if (!instance) {
        return undefined;
      }
      return instance as any;
    }
    throw new Error(`Invalid extension type: ${typeof extension}`);
  }

  /**
   * Check if an extension exists
   */
  public hasExtension(key: string | Extension | ExtensionFactory): boolean {
    if (typeof key === "string") {
      return this.extensions.some((e) => e.key === key);
    } else if (typeof key === "object" && "key" in key) {
      return this.extensions.some((e) => e.key === key.key);
    } else if (typeof key === "function") {
      return this.extensionFactories.has(key);
    }
    return false;
  }
}

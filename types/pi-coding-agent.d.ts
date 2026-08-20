// Ambient type stubs for "@earendil-works/pi-coding-agent".
//
// The real package publishes richer types than pi's runtime actually
// enforces (e.g. AgentToolResult.details is declared required, but every
// shipped extension in this repo omits it and pi runs them fine). Rather
// than fight that mismatch — or bloat the tree with the package's ~140
// transitive devDependencies — this stub covers exactly the members these
// extensions import, typed to match the *duck-typed* contract the code
// already assumes (see the local UiCtx/UiLite interfaces this replaces).
//
// Keep this file's exports in sync with `grep -h '@earendil-works/pi-coding-agent' packages/*/*.mjs packages/*/*.ts`.

declare module "@earendil-works/pi-coding-agent" {
  /** One content block returned to the model. */
  export interface AgentToolContentBlock {
    type: string;
    text?: string;
    [key: string]: unknown;
  }

  /** Final or partial result produced by a tool. `details` is optional here —
   * pi's runtime does not require it even though the published SDK types do. */
  export interface AgentToolResult<T = unknown> {
    content: AgentToolContentBlock[];
    details?: T;
    usage?: unknown;
    isError?: boolean;
    terminate?: boolean;
    addedToolNames?: string[];
  }

  export type AgentToolUpdateCallback<T = unknown> = (partial: AgentToolResult<T>) => void;

  /** TUI object handed to the custom footer renderer — used to request re-renders. */
  export interface FooterTui {
    requestRender?(): void;
  }

  /** Data exposed only through the footer renderer, not otherwise reachable by extensions. */
  export interface FooterData {
    getGitBranch?(): string | null;
    getExtensionStatuses?(): ReadonlyMap<string, string>;
    onBranchChange?(cb: () => void): () => void;
  }

  /** Callback passed to `ctx.ui.setFooter`. */
  export interface FooterCallback {
    (tui: FooterTui, theme: ExtensionUIContext["theme"], footerData: FooterData): {
      invalidate(): void;
      render(width: number): string[];
      dispose?: () => void;
    };
  }

  export interface ExtensionUIContext {
    notify?(title: string, level?: string): void;
    setStatus?(id: string, text: string | undefined): void;
    setWidget?(id: string, lines: string[] | undefined): void;
    setFooter?(footer: FooterCallback | undefined): void;
    editor?(title: string, prefill?: string): Promise<string | undefined>;
    select?(title: string, options: string[]): Promise<string | undefined>;
    input?(title: string, value?: string): Promise<string | undefined>;
    theme?: { fg?: (color: string, text: string) => string };
    [key: string]: unknown;
  }

  /** Loose, duck-typed context object passed to event handlers, tool
   * `execute`, and command handlers alike — real contexts carry more, but
   * every extension in this repo only ever reads this subset. */
  export interface ExtensionContext {
    cwd?: string;
    hasUI?: boolean;
    isProjectTrusted?(): boolean;
    model?: { id?: string; provider?: string; [key: string]: unknown };
    modelRegistry?: { getModel?: (provider: string, id: string) => unknown };
    sessionManager?: { getBranch?(): unknown[] };
    signal?: AbortSignal;
    thinkingLevel?: string;
    shutdown(): void;
    ui?: ExtensionUIContext;
    [key: string]: unknown;
  }

  export type ExtensionCommandContext = ExtensionContext;

  export interface ToolDefinition<TParams = unknown, TDetails = unknown> {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: TParams;
    execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TDetails>>;
    renderResult?: (...args: unknown[]) => unknown;
  }

  export interface CommandDefinition {
    description?: string;
    handler(args: string, ctx: ExtensionCommandContext): void | Promise<void>;
  }

  export interface FlagDefinition {
    description?: string;
    type: "boolean" | "string" | "number";
    default?: unknown;
  }

  export interface ShortcutDefinition {
    description?: string;
    handler(ctx: ExtensionContext): void | Promise<void>;
  }

  export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  export interface EventBus {
    emit(name: string, payload?: unknown): void;
    on?(name: string, handler: (payload: unknown) => void): void;
  }

  /** The object every extension's default export receives. */
  export interface ExtensionAPI {
    registerCommand(name: string, def: CommandDefinition): void;
    registerTool<TParams = unknown, TDetails = unknown>(def: ToolDefinition<TParams, TDetails>): void;
    registerFlag(name: string, def: FlagDefinition): void;
    registerShortcut(keybinding: string, def: ShortcutDefinition): void;
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any): void;
    exec(cmd: string, args: string[], opts?: { timeout?: number }): Promise<ExecResult>;
    getActiveTools(): string[];
    setActiveTools(tools: string[]): void;
    getFlag(name: string): unknown;
    sendUserMessage(text: string, opts?: { deliverAs?: string }): Promise<void>;
    events: EventBus;
  }

  /** Directory pi stores per-user agent config/state under (~/.pi/agent). */
  export function getAgentDir(): string;

  /** Splits `---\nyaml\n---\nbody` frontmatter from a Markdown file's text. */
  export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string };

  // --- pi-subagents' spawn.mjs also value-imports these at runtime. spawn.mjs
  // itself is untyped (see types/mjs-modules.d.ts), so these only need to
  // exist for module-resolution purposes; they stay intentionally coarse.
  export function createAgentSession(options: any): Promise<any> | any;
  export class DefaultResourceLoader {
    constructor(...args: any[]);
  }
  export class SessionManager {
    constructor(...args: any[]);
  }
}

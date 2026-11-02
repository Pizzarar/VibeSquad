// Local ambient types for the Paseo server-plugin SDK. @getpaseo/plugin is not a
// dependency of this repo, so the plugin typechecks against this minimal surface.
declare module "@getpaseo/plugin/server" {
  export interface PluginServerContext {
    before(event: string, handler: (input: any) => any): () => void;
    on(event: string, handler: (input: any, ctx: { paseo: any }) => any): () => void;
    handle?(
      contract: { name: string; input: { parseAsync(v: unknown): Promise<any> }; output: { parseAsync(v: unknown): Promise<any> } },
      handler: (input: any, ctx: { paseo: any }) => unknown,
    ): void;
  }
}

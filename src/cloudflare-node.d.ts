declare module 'cloudflare:node' {
  export interface HttpServerHandlerOptions {
    port: number;
  }

  export interface HttpServerHandler {
    fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response>;
  }

  export function httpServerHandler(options: HttpServerHandlerOptions): HttpServerHandler;
}

import { handleImport, type Env } from "./handler";

type WorkerEnv = Env & {
  ASSETS: Fetcher;
  /** Public repository of the deployed code (AGPL-3.0 §13: offer the source to users). */
  SOURCE_URL: string;
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/import") return handleImport(request, env);
    // Android share received while no service worker is active (first share before it
    // installed, or storage evicted by the browser): the upload has already reached
    // Cloudflare at this point. The body is never read, logged or stored; the page then
    // asks the user to pick the file manually. The page requests persistent storage to
    // make this case rare; it cannot be prevented from the server side.
    if (url.pathname === "/share") return Response.redirect(new URL("/?shared=1", url).toString(), 303);
    if (url.pathname === "/source") {
      return env.SOURCE_URL
        ? Response.redirect(env.SOURCE_URL, 302)
        : new Response("SOURCE_URL is not configured in wrangler.jsonc.", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;

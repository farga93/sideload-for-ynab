// Service worker: receives the file shared from another Android app (Web Share Target),
// stores it in a local cache, then opens the page that processes it. The file never leaves
// the device; the page deletes it from the cache as soon as it has read it.
const SHARE_CACHE = "share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share") return;

  event.respondWith(
    (async () => {
      const form = await event.request.formData();
      const file = form.get("file");
      const cache = await caches.open(SHARE_CACHE);
      if (file instanceof File) {
        await cache.put(
          "/shared-file",
          new Response(file, { headers: { "X-Filename": encodeURIComponent(file.name) } }),
        );
      }
      return Response.redirect("/?shared=1", 303);
    })(),
  );
});

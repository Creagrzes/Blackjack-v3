export { Table } from "./table.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/logs" || url.pathname === "/admin") {
      return env.TABLE.get(env.TABLE.idFromName("main")).fetch(request);
    }
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Oczekiwano połączenia WebSocket", { status: 426 });
      }
      const stub = env.TABLE.get(env.TABLE.idFromName("main"));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

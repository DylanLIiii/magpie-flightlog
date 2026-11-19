import { startServer } from "./lib/server.mjs";
let service;
export default {
  id: "magpie-flightlog",
  async server(input, options) {
    service ??= startServer({
      port: options?.port ?? 3467,
      dir: input.directory,
    }).catch((err) => {
      service = null;
      throw err;
    });
    await service;
    return {};
  },
};

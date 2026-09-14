// Electron preload bridge: expose the library through contextBridge so the
// renderer never touches Node primitives. The renderer gets the same
// createClient / createManualSession surface as every other consumer.
import { contextBridge, ipcRenderer } from "electron";
import { createClient, createManualSession } from "../../dist/index.js";

const client = createClient();

contextBridge.exposeInMainWorld("powerduck", {
  // read-only facts the renderer needs at mount time
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },

  // UI-first client (prepare decides the renderer before anything is sent)
  prepare: (options) => client.prepare(options),
  send: (options) => client.send(options),
  sendMany: (options) => client.sendMany(options),
  probeStreamingResponse: (input, init) => client.probeStreamingResponse(input, init),
  writeback: (spec, prepared, result, writeOptions) =>
    client.writeback(spec, prepared, result, writeOptions),

  // long-lived sessions (websocket / mcp / grpc)
  connect: (options) => client.connect(options),

  // schema discovery (mcp / grpc / graphql)
  discover: (options) => client.discover(options),

  // heavy I/O is delegated to the main process on demand
  pickFile: () => ipcRenderer.invoke("powerduck:pick-file"),
  saveFile: (payload) => ipcRenderer.invoke("powerduck:save-file", payload),
});

export { createClient, createManualSession };

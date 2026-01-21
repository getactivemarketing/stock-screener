import * as server from '../entries/pages/ticker/_symbol_/_page.server.ts.js';

export const index = 3;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/ticker/_symbol_/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/ticker/[symbol]/+page.server.ts";
export const imports = ["_app/immutable/nodes/3.PJxbqX8P.js","_app/immutable/chunks/IdZxz9_D.js","_app/immutable/chunks/CJVWN2P9.js","_app/immutable/chunks/Ng2YzemH.js","_app/immutable/chunks/D7XHfT7T.js","_app/immutable/chunks/CciVzwLS.js","_app/immutable/chunks/DMUSPNmw.js","_app/immutable/chunks/X8ZlJyyB.js"];
export const stylesheets = [];
export const fonts = [];
